@preconcurrency import AVFoundation
import Foundation
import OSLog
@preconcurrency import WebRTC

enum CodexWebRTCError: LocalizedError {
    case peerConnectionCreationFailed
    case offerCreationFailed
    case localDescriptionUnavailable
    case sessionAlreadyStarted
    case sessionNotStarted
    case connectionTimedOut
    case connectionFailed
    case connectionLost

    var errorDescription: String? {
        switch self {
        case .peerConnectionCreationFailed: "Could not create the Codex audio connection."
        case .offerCreationFailed: "Could not create the Codex WebRTC offer."
        case .localDescriptionUnavailable: "The Codex WebRTC offer was incomplete."
        case .sessionAlreadyStarted: "The Codex audio connection is already active."
        case .sessionNotStarted: "The Codex audio connection has not started."
        case .connectionTimedOut: "The Codex audio connection timed out."
        case .connectionFailed: "The Codex audio connection could not be established."
        case .connectionLost: "The Codex audio connection was lost."
        }
    }

    var isRecoverableConnectionFailure: Bool {
        switch self {
        case .connectionTimedOut, .connectionFailed:
            true
        default:
            false
        }
    }
}

enum CodexConnectionRetryPolicy {
    static let maximumAttempts = 2

    static func shouldRetry(after attempt: Int, error: Error) -> Bool {
        attempt < maximumAttempts
            && (error as? CodexWebRTCError)?.isRecoverableConnectionFailure == true
    }
}

@MainActor
final class CodexWebRTCSession: NSObject {
    var onFailure: ((Error) -> Void)?
    var onRemoteAudioStarted: (() -> Void)?

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
    }()

    private let logger = Logger(subsystem: "com.chirag.agentcaller", category: "CodexWebRTC")
    private let delegateAdapter = DelegateAdapter()
    private var peerConnection: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private var audioTrack: RTCAudioTrack?
    private var disconnectGraceTask: Task<Void, Never>?
    private var iceCandidateCount = 0
    private var audioActivated = false
    private var microphoneAllowed = false
    private var muted = false
    private var reportedRemoteAudio = false
    private var hasConnected = false
    private var stopped = false

    override init() {
        super.init()
        delegateAdapter.owner = self
    }

    func createOffer(prewarming: Bool = false) async throws -> String {
        guard peerConnection == nil else { throw CodexWebRTCError.sessionAlreadyStarted }
        stopped = false
        if !prewarming {
            enableWebRTCAudio()
            audioActivated = true
            microphoneAllowed = true
        }

        let configuration = RTCConfiguration()
        configuration.iceServers = []
        configuration.sdpSemantics = .unifiedPlan
        // Caller sends one complete SDP offer and does not trickle later candidates.
        configuration.continualGatheringPolicy = .gatherOnce
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let connection = Self.factory.peerConnection(
            with: configuration,
            constraints: constraints,
            delegate: delegateAdapter
        ) else {
            disableWebRTCAudio()
            throw CodexWebRTCError.peerConnectionCreationFailed
        }
        peerConnection = connection

        let audioSource = Self.factory.audioSource(
            with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        )
        let track = Self.factory.audioTrack(with: audioSource, trackId: "caller-codex-audio")
        track.isEnabled = audioActivated && microphoneAllowed && !muted
        audioTrack = track
        let transceiver = RTCRtpTransceiverInit()
        transceiver.direction = .sendRecv
        connection.addTransceiver(with: track, init: transceiver)

        let dataConfiguration = RTCDataChannelConfiguration()
        dataConfiguration.isOrdered = true
        dataChannel = connection.dataChannel(
            forLabel: "oai-events",
            configuration: dataConfiguration
        )
        dataChannel?.delegate = delegateAdapter

        let offer = try await offer(
            connection,
            constraints: RTCMediaConstraints(
                mandatoryConstraints: [
                    "OfferToReceiveAudio": kRTCMediaConstraintsValueTrue,
                    "OfferToReceiveVideo": kRTCMediaConstraintsValueFalse,
                ],
                optionalConstraints: nil
            )
        )
        try await setLocalDescription(offer, on: connection)
        try await waitForICE(on: connection)
        guard let sdp = connection.localDescription?.sdp else {
            stop()
            throw CodexWebRTCError.localDescriptionUnavailable
        }
        return sdp
    }

    func applyAnswer(_ sdp: String) async throws {
        guard let connection = peerConnection else { throw CodexWebRTCError.sessionNotStarted }
        try await setRemoteDescription(
            RTCSessionDescription(type: .answer, sdp: sdp),
            on: connection
        )
    }

    func waitUntilConnected(timeout: Duration = .seconds(8)) async throws {
        guard let connection = peerConnection else { throw CodexWebRTCError.sessionNotStarted }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)

        while clock.now < deadline {
            try Task.checkCancellation()
            switch connection.connectionState {
            case .connected:
                hasConnected = true
                logger.info("WebRTC media connection established")
                return
            case .failed, .closed:
                throw CodexWebRTCError.connectionFailed
            case .new, .connecting, .disconnected:
                break
            @unknown default:
                break
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw CodexWebRTCError.connectionTimedOut
    }

    func setMuted(_ muted: Bool) {
        self.muted = muted
        audioTrack?.isEnabled = audioActivated && microphoneAllowed && !muted
    }

    static func audioSessionDidActivate(_ audioSession: AVAudioSession) {
        RTCAudioSession.sharedInstance().audioSessionDidActivate(audioSession)
    }

    static func audioSessionDidDeactivate(_ audioSession: AVAudioSession) {
        RTCAudioSession.sharedInstance().audioSessionDidDeactivate(audioSession)
    }

    static func configureAudioSession() throws {
        let rtcSession = RTCAudioSession.sharedInstance()
        rtcSession.lockForConfiguration()
        defer { rtcSession.unlockForConfiguration() }
        try rtcSession.setCategory(
            CallAudioRoutePolicy.category,
            mode: CallAudioRoutePolicy.mode,
            options: CallAudioRoutePolicy.options
        )
    }

    static func selectAudioRoute(_ kind: CallAudioRouteOption.Kind) throws {
        let rtcSession = RTCAudioSession.sharedInstance()
        rtcSession.lockForConfiguration()
        defer { rtcSession.unlockForConfiguration() }

        for command in kind.commands {
            switch command {
            case .overrideOutput(let override):
                try rtcSession.overrideOutputAudioPort(override)
            case .selectInput(let uid):
                guard let input = rtcSession.session.availableInputs?.first(where: { $0.uid == uid }) else {
                    throw NSError(
                        domain: "com.chirag.agentcaller.audio-route",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "The selected audio input is no longer available."]
                    )
                }
                try rtcSession.setPreferredInput(input)
            }
        }
    }

    func activateAudio(allowMicrophone: Bool = true) {
        if allowMicrophone {
            microphoneAllowed = true
        }
        guard !audioActivated else { return }
        audioActivated = true
        enableWebRTCAudio()
        audioTrack?.isEnabled = microphoneAllowed && !muted
    }

    func enableMicrophone() {
        microphoneAllowed = true
        audioTrack?.isEnabled = audioActivated && !muted
    }

    func stop() {
        stopped = true
        disconnectGraceTask?.cancel()
        disconnectGraceTask = nil
        dataChannel?.close()
        dataChannel = nil
        audioTrack = nil
        peerConnection?.close()
        peerConnection = nil
        audioActivated = false
        microphoneAllowed = false
        reportedRemoteAudio = false
        hasConnected = false
        iceCandidateCount = 0
        disableWebRTCAudio()
    }

    private func enableWebRTCAudio() {
        let session = RTCAudioSession.sharedInstance()
        session.useManualAudio = true
        session.isAudioEnabled = true
    }

    private func disableWebRTCAudio() {
        let session = RTCAudioSession.sharedInstance()
        session.isAudioEnabled = false
        session.useManualAudio = false
    }

    private func offer(
        _ connection: RTCPeerConnection,
        constraints: RTCMediaConstraints
    ) async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { continuation in
            connection.offer(for: constraints) { description, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let description {
                    continuation.resume(returning: description)
                } else {
                    continuation.resume(throwing: CodexWebRTCError.offerCreationFailed)
                }
            }
        }
    }

    private func setLocalDescription(
        _ description: RTCSessionDescription,
        on connection: RTCPeerConnection
    ) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.setLocalDescription(description) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    private func setRemoteDescription(
        _ description: RTCSessionDescription,
        on connection: RTCPeerConnection
    ) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.setRemoteDescription(description) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    private func waitForICE(on connection: RTCPeerConnection) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .milliseconds(2_500))
        while connection.iceGatheringState != .complete, clock.now < deadline {
            try Task.checkCancellation()
            try await Task.sleep(for: .milliseconds(50))
        }
        logger.info(
            "ICE offer ready with \(self.iceCandidateCount, privacy: .public) candidates; gathering complete: \(connection.iceGatheringState == .complete, privacy: .public)"
        )
    }

    fileprivate func iceGatheringChanged(_ state: RTCIceGatheringState) {
        logger.info("ICE gathering state changed to \(String(describing: state.rawValue), privacy: .public)")
    }

    fileprivate func iceCandidateGenerated() {
        iceCandidateCount += 1
    }

    fileprivate func iceConnectionChanged(_ state: RTCIceConnectionState) {
        logger.info("ICE connection state changed to \(String(describing: state.rawValue), privacy: .public)")
    }

    fileprivate func connectionStateChanged(_ state: RTCPeerConnectionState) {
        logger.info("Peer connection state changed to \(String(describing: state.rawValue), privacy: .public)")
        guard !stopped else { return }

        switch state {
        case .connected:
            hasConnected = true
            disconnectGraceTask?.cancel()
            disconnectGraceTask = nil
        case .disconnected where hasConnected:
            disconnectGraceTask?.cancel()
            disconnectGraceTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled else { return }
                guard let self, !self.stopped,
                      self.peerConnection?.connectionState == .disconnected else { return }
                self.onFailure?(CodexWebRTCError.connectionLost)
            }
        case .failed where hasConnected:
            onFailure?(CodexWebRTCError.connectionLost)
        default:
            break
        }
    }

    fileprivate func remoteAudioStarted() {
        guard !reportedRemoteAudio else { return }
        reportedRemoteAudio = true
        logger.info("Remote RTP audio started")
        onRemoteAudioStarted?()
    }

    fileprivate func dataChannelMessage(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }
        if type == "error" {
            let details = object["error"] as? [String: Any]
            let message = details?["message"] as? String ?? "The Codex realtime session failed."
            onFailure?(NSError(
                domain: "com.chirag.agentcaller.codex-realtime",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: message]
            ))
            return
        }
        guard !reportedRemoteAudio,
              type.contains("audio"),
              type.hasSuffix(".delta"),
              !type.contains("transcript") else { return }
        remoteAudioStarted()
    }

}

private final class DelegateAdapter: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, @unchecked Sendable {
    weak var owner: CodexWebRTCSession?

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let owner = self.owner
        Task { @MainActor in owner?.iceConnectionChanged(newState) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        let owner = self.owner
        Task { @MainActor in owner?.connectionStateChanged(newState) }
    }

    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didStartReceivingOn transceiver: RTCRtpTransceiver
    ) {
        let owner = self.owner
        Task { @MainActor in owner?.remoteAudioStarted() }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        let owner = self.owner
        Task { @MainActor in owner?.iceGatheringChanged(newState) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let owner = self.owner
        Task { @MainActor in owner?.iceCandidateGenerated() }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary else { return }
        let owner = self.owner
        let data = buffer.data
        Task { @MainActor in owner?.dataChannelMessage(data) }
    }
}
