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
    private var socket: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var socketDelegate: GrokSocketDelegate?
    private var voiceSessionID: String?
    private var activeCallID: UUID?
    private var stopped = false

    func start(callID: UUID, client: VoiceBootstrapClient) {
        stop(revoke: false)
        stopped = false
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
            try? sendJSON([
                "type": "response.create",
                "response": ["modalities": ["text", "audio"]],
            ])
        case "input_audio_buffer.speech_started":
            audio.interruptPlayback()
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
