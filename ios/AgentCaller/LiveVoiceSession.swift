@preconcurrency import AVFoundation
import Foundation
import OSLog

@MainActor
final class LiveVoiceSession {
    var onFailure: ((Error) -> Void)?
    var onReady: (() -> Void)?
    var onSpeakingPermissionWillSend: (() -> Void)?
    var onRemoteAudioStarted: (() -> Void)?

    private let logger = Logger(subsystem: "com.chirag.agentcaller", category: "LiveVoice")
    private var startTask: Task<Void, Never>?
    private var activationTask: Task<Void, Never>?
    private var webRTC: CodexWebRTCSession?
    private var grok: GrokVoiceSession?
    private var client: VoiceBootstrapClient?
    private var bootstrap: VoiceBootstrap?
    private var voiceSessionID: String?
    private var activeCallID: UUID?
    private var answered = false
    private var activationStarted = false
    private var stopped = false
    private var prewarmStartedAt: Date?

    static func configureAudioSession() throws {
        try CodexWebRTCSession.configureAudioSession()
    }

    func prewarm(callID: UUID, client: VoiceBootstrapClient) {
        stop(revoke: false)
        stopped = false
        prewarmStartedAt = Date()
        activeCallID = callID
        self.client = client
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                let candidate = CodexWebRTCSession()
                self.configureCallbacks(for: candidate)
                self.webRTC = candidate
                let offer = try await candidate.createOffer(prewarming: true)
                self.logElapsed("WebRTC offer ready")
                let bootstrap = try await client.create(callID: callID, offerSDP: offer)
                self.logElapsed("voice bootstrap returned")
                try Task.checkCancellation()
                guard self.activeCallID == callID, !self.stopped else { return }
                self.voiceSessionID = bootstrap.voiceSessionID
                self.bootstrap = bootstrap

                switch bootstrap.provider {
                case .codex:
                    guard let answer = bootstrap.webrtc?.answerSDP else {
                        throw VoiceBootstrapError.invalidResponse
                    }
                    try await candidate.applyAnswer(answer)
                    self.logElapsed("Codex SDP applied")
                case .xai:
                    candidate.stop()
                    self.webRTC = nil
                }
                self.activateIfAnswered()
            } catch is CancellationError {
                return
            } catch {
                self.fail(error)
            }
        }
    }

    func answer() {
        guard !stopped else { return }
        answered = true
        logElapsed("CallKit answered")
        webRTC?.activateAudio(allowMicrophone: false)
        activateIfAnswered()
    }

    func stop(revoke: Bool = true) {
        stopped = true
        startTask?.cancel()
        startTask = nil
        activationTask?.cancel()
        activationTask = nil
        webRTC?.stop()
        webRTC = nil
        grok?.stop(revoke: false)
        grok = nil
        activeCallID = nil
        bootstrap = nil
        answered = false
        activationStarted = false
        if revoke, let voiceSessionID, let client {
            Task { await client.revoke(voiceSessionID: voiceSessionID) }
        }
        voiceSessionID = nil
        client = nil
    }

    func setMuted(_ muted: Bool) {
        webRTC?.setMuted(muted)
        grok?.setMuted(muted)
    }

    static func audioSessionDidActivate(_ audioSession: AVAudioSession) {
        CodexWebRTCSession.audioSessionDidActivate(audioSession)
    }

    static func audioSessionDidDeactivate(_ audioSession: AVAudioSession) {
        CodexWebRTCSession.audioSessionDidDeactivate(audioSession)
    }

    func selectAudioRoute(_ kind: CallAudioRouteOption.Kind) throws {
        try CodexWebRTCSession.selectAudioRoute(kind)
    }

    private func activateIfAnswered() {
        guard answered, !activationStarted, let bootstrap, let client, let activeCallID else { return }
        activationStarted = true
        switch bootstrap.provider {
        case .codex:
            activationTask = Task { [weak self] in
                guard let self else { return }
                do {
                    let connectedBootstrap = try await self.connectCodexWithRetry(
                        initialBootstrap: bootstrap,
                        callID: activeCallID,
                        client: client
                    )
                    try Task.checkCancellation()
                    guard !self.stopped else { return }
                    self.onSpeakingPermissionWillSend?()
                    self.logElapsed("media connected; sending speaking permission")
                    try await client.markAnswered(voiceSessionID: connectedBootstrap.voiceSessionID)
                    self.logElapsed("speaking permission acknowledged")
                    try Task.checkCancellation()
                    guard !self.stopped else { return }
                    guard let webRTC = self.webRTC else { throw CodexWebRTCError.sessionNotStarted }
                    webRTC.enableMicrophone()
                    self.logElapsed("microphone enabled")
                    self.onReady?()
                } catch is CancellationError {
                    return
                } catch {
                    self.fail(error)
                }
            }
        case .xai:
            do {
                let session = GrokVoiceSession()
                session.onFailure = { [weak self] error in self?.fail(error) }
                session.onReady = { [weak self] in self?.onReady?() }
                self.grok = session
                try session.start(bootstrap: bootstrap, client: client, callID: activeCallID)
            } catch {
                fail(error)
            }
        }
    }

    private func connectCodexWithRetry(
        initialBootstrap: VoiceBootstrap,
        callID: UUID,
        client: VoiceBootstrapClient
    ) async throws -> VoiceBootstrap {
        var attempt = 1
        var currentBootstrap = initialBootstrap

        while true {
            try Task.checkCancellation()
            guard activeCallID == callID, !stopped,
                  let candidate = webRTC else { throw CancellationError() }
            candidate.activateAudio(allowMicrophone: false)
            logElapsed("waiting for Codex media connection (attempt \(attempt))")

            do {
                try await candidate.waitUntilConnected()
                return currentBootstrap
            } catch {
                guard CodexConnectionRetryPolicy.shouldRetry(after: attempt, error: error) else {
                    throw error
                }

                attempt += 1
                logger.warning(
                    "Codex media attempt \(attempt - 1, privacy: .public) failed; creating fresh session: \(error.localizedDescription, privacy: .public)"
                )
                let staleVoiceSessionID = currentBootstrap.voiceSessionID
                candidate.stop()
                if webRTC === candidate { webRTC = nil }
                Task { await client.revoke(voiceSessionID: staleVoiceSessionID) }

                try Task.checkCancellation()
                guard activeCallID == callID, !stopped else { throw CancellationError() }
                let replacement = CodexWebRTCSession()
                configureCallbacks(for: replacement)
                webRTC = replacement
                let offer = try await replacement.createOffer(prewarming: true)
                logElapsed("retry WebRTC offer ready")
                let replacementBootstrap = try await client.create(callID: callID, offerSDP: offer)
                guard replacementBootstrap.provider == .codex,
                      let answer = replacementBootstrap.webrtc?.answerSDP else {
                    throw VoiceBootstrapError.invalidResponse
                }
                try Task.checkCancellation()
                guard activeCallID == callID, !stopped, webRTC === replacement else {
                    replacement.stop()
                    throw CancellationError()
                }
                voiceSessionID = replacementBootstrap.voiceSessionID
                bootstrap = replacementBootstrap
                try await replacement.applyAnswer(answer)
                logElapsed("retry Codex SDP applied")
                currentBootstrap = replacementBootstrap
            }
        }
    }

    private func configureCallbacks(for candidate: CodexWebRTCSession) {
        candidate.onFailure = { [weak self, weak candidate] error in
            guard let self, let candidate, self.webRTC === candidate else { return }
            self.fail(error)
        }
        candidate.onRemoteAudioStarted = { [weak self, weak candidate] in
            guard let self, let candidate, self.webRTC === candidate else { return }
            self.onRemoteAudioStarted?()
        }
    }

    private func fail(_ error: Error) {
        guard !stopped else { return }
        logger.error("Live voice failed: \(error.localizedDescription, privacy: .public)")
        stopped = true
        onFailure?(error)
    }

    private func logElapsed(_ event: String) {
        let milliseconds = Int((Date().timeIntervalSince(prewarmStartedAt ?? Date())) * 1_000)
        logger.info("\(event, privacy: .public) after \(milliseconds, privacy: .public) ms")
    }
}
