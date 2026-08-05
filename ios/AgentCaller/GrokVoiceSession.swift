import Foundation
import OSLog

@MainActor
final class GrokVoiceSession {
    var onFailure: ((Error) -> Void)?

    private let logger = Logger(subsystem: "com.chirag.agentcaller", category: "GrokVoice")
    private let audio = RealtimeAudioEngine()
    private var bootstrapClient: VoiceBootstrapClient?
    private var bootstrapTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var operationEventsTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var socketDelegate: GrokSocketDelegate?
    private var voiceSessionID: String?
    private var activeCallID: UUID?
    private var stopped = false
    private var responseGate = GrokResponseGate()

    func start(callID: UUID, client: VoiceBootstrapClient) {
        stop(revoke: false)
        stopped = false
        responseGate = GrokResponseGate()
        activeCallID = callID
        bootstrapClient = client
        bootstrapTask = Task { [weak self] in
            guard let self else { return }
            do {
                let bootstrap = try await client.create(callID: callID)
                try Task.checkCancellation()
                guard self.activeCallID == callID, !self.stopped else { return }
                self.voiceSessionID = bootstrap.voiceSessionID
                try self.connect(bootstrap)
            } catch is CancellationError {
                return
            } catch {
                self.fail(error)
            }
        }
    }

    func stop(revoke: Bool = true) {
        stopped = true
        bootstrapTask?.cancel()
        bootstrapTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        operationEventsTask?.cancel()
        operationEventsTask = nil
        audio.stop()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        socketDelegate = nil
        activeCallID = nil
        if revoke, let voiceSessionID, let bootstrapClient {
            Task { await bootstrapClient.revoke(voiceSessionID: voiceSessionID) }
        }
        voiceSessionID = nil
        bootstrapClient = nil
    }

    func setMuted(_ muted: Bool) {
        audio.setMuted(muted)
    }

    private func connect(_ bootstrap: VoiceBootstrap) throws {
        var components = URLComponents(string: "wss://api.x.ai/v1/realtime")!
        components.queryItems = [URLQueryItem(name: "model", value: bootstrap.xai.model)]
        guard let url = components.url else { throw VoiceBootstrapError.invalidResponse }
        let delegate = GrokSocketDelegate { [weak self] in
            Task { @MainActor in self?.socketOpened(bootstrap) }
        } onClose: { [weak self] error in
            Task { @MainActor in
                guard let self, !self.stopped else { return }
                self.fail(error ?? URLError(.networkConnectionLost))
            }
        }
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        let socket = session.webSocketTask(
            with: url,
            protocols: ["xai-client-secret.\(bootstrap.xai.ephemeralToken)"]
        )
        self.socketDelegate = delegate
        self.urlSession = session
        self.socket = socket
        socket.resume()
        receiveTask = Task { [weak self] in await self?.receiveLoop() }
    }

    private func socketOpened(_ bootstrap: VoiceBootstrap) {
        do {
            let sessionObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(bootstrap.session))
            try sendJSON(["type": "session.update", "session": sessionObject])
            try audio.start { [weak self] data in
                Task { @MainActor in self?.socket?.send(.data(data)) { _ in } }
            }
            startHermesEventLoop()
        } catch {
            fail(error)
        }
    }

    private func receiveLoop() async {
        while !Task.isCancelled, let socket {
            do {
                let message = try await socket.receive()
                switch message {
                case .data(let data):
                    audio.play(data)
                case .string(let text):
                    handleEvent(text)
                @unknown default:
                    break
                }
            } catch is CancellationError {
                return
            } catch {
                if !stopped { fail(error) }
                return
            }
        }
    }

    private func handleEvent(_ text: String) {
        guard let data = text.data(using: .utf8),
              let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = event["type"] as? String else { return }
        switch type {
        case "session.updated":
            requestResponse()
        case "response.created":
            responseGate.responseCreated()
        case "response.done":
            responseGate.responseDone()
            requestPendingHermesResponseIfPossible()
        case "input_audio_buffer.speech_started":
            responseGate.userSpeechStarted()
            audio.interruptPlayback()
        case "input_audio_buffer.speech_stopped":
            responseGate.userSpeechStopped()
        case "ping":
            if let timestamp = event["ping_timestamp"] {
                try? sendJSON(["type": "pong", "ping_timestamp": timestamp])
            }
        case "error":
            let message = event["message"] as? String ?? "xAI voice session error"
            fail(NSError(domain: "XAIRealtime", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
        default:
            break
        }
    }

    private func startHermesEventLoop() {
        operationEventsTask?.cancel()
        guard let bootstrapClient, let voiceSessionID else { return }
        operationEventsTask = Task { [weak self] in
            var cursor = 0
            var retryDelayNanoseconds: UInt64 = 750_000_000
            while !Task.isCancelled {
                do {
                    let page = try await bootstrapClient.hermesEvents(
                        voiceSessionID: voiceSessionID,
                        after: cursor
                    )
                    try Task.checkCancellation()
                    guard let self, !self.stopped else { return }
                    for event in page.events {
                        cursor = max(cursor, event.cursor)
                        if event.status != "queued" { self.injectHermesEvent(event) }
                    }
                    cursor = max(cursor, page.nextCursor)
                    retryDelayNanoseconds = 750_000_000
                    try await Task.sleep(nanoseconds: 750_000_000)
                } catch is CancellationError {
                    return
                } catch VoiceBootstrapError.rejected(let status) where status == 404 || status == 410 {
                    return
                } catch {
                    guard let self, !self.stopped else { return }
                    self.logger.warning(
                        "Hermes event polling failed; retrying: \(error.localizedDescription, privacy: .public)"
                    )
                    try? await Task.sleep(nanoseconds: retryDelayNanoseconds)
                    retryDelayNanoseconds = min(retryDelayNanoseconds * 2, 5_000_000_000)
                }
            }
        }
    }

    private func injectHermesEvent(_ event: HermesOperationEvent) {
        do {
            try sendJSON([
                "type": "conversation.item.create",
                "item": [
                    "type": "message",
                    "role": "user",
                    "content": [[
                        "type": "input_text",
                        "text": try event.conversationEnvelope(),
                    ]],
                ],
            ])
            if event.shouldPromptResponse {
                responseGate.hermesCompletionArrived()
                requestPendingHermesResponseIfPossible()
            }
        } catch {
            fail(error)
        }
    }

    private func requestPendingHermesResponseIfPossible() {
        guard responseGate.consumeHermesResponseRequestIfPossible() else { return }
        sendResponseCreate()
    }

    private func requestResponse() {
        guard responseGate.consumeOrdinaryResponseRequestIfPossible() else { return }
        sendResponseCreate()
    }

    private func sendResponseCreate() {
        do {
            try sendJSON([
                "type": "response.create",
                "response": ["modalities": ["text", "audio"]],
            ])
        } catch {
            responseGate.responseRequestFailed()
            fail(error)
        }
    }

    private func sendJSON(_ object: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let text = String(data: data, encoding: .utf8), let socket else {
            throw VoiceBootstrapError.invalidResponse
        }
        socket.send(.string(text)) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in self?.fail(error) }
        }
    }

    private func fail(_ error: Error) {
        guard !stopped else { return }
        logger.error("Live voice failed: \(error.localizedDescription, privacy: .public)")
        stopped = true
        onFailure?(error)
    }
}

struct GrokResponseGate: Equatable {
    private(set) var responseActive = false
    private(set) var responseRequested = false
    private(set) var userSpeaking = false
    private(set) var hermesResponsePending = false
    private(set) var automaticResponseExpected = false

    mutating func responseCreated() {
        if automaticResponseExpected {
            hermesResponsePending = false
        }
        automaticResponseExpected = false
        responseRequested = false
        responseActive = true
    }

    mutating func responseDone() {
        responseRequested = false
        responseActive = false
    }

    mutating func userSpeechStarted() {
        userSpeaking = true
        automaticResponseExpected = false
    }

    mutating func userSpeechStopped() {
        userSpeaking = false
        automaticResponseExpected = true
    }

    mutating func hermesCompletionArrived() {
        hermesResponsePending = true
    }

    mutating func consumeOrdinaryResponseRequestIfPossible() -> Bool {
        guard !responseActive, !responseRequested else { return false }
        responseRequested = true
        return true
    }

    mutating func consumeHermesResponseRequestIfPossible() -> Bool {
        guard hermesResponsePending,
              !responseActive,
              !responseRequested,
              !userSpeaking,
              !automaticResponseExpected else {
            return false
        }
        hermesResponsePending = false
        responseRequested = true
        return true
    }

    mutating func responseRequestFailed() {
        responseRequested = false
    }
}

private final class GrokSocketDelegate: NSObject, URLSessionWebSocketDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let onOpen: @Sendable () -> Void
    let onClose: @Sendable (Error?) -> Void

    init(onOpen: @escaping @Sendable () -> Void, onClose: @escaping @Sendable (Error?) -> Void) {
        self.onOpen = onOpen
        self.onClose = onClose
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        onOpen()
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        onClose(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { onClose(error) }
    }
}
