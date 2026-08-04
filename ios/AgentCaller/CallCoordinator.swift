@preconcurrency import AVFoundation
@preconcurrency import CallKit
import Combine
import OSLog

enum CallAudioRoutePolicy {
    static let category: AVAudioSession.Category = .playAndRecord
    static let mode: AVAudioSession.Mode = .voiceChat
    static let options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP]
}

struct ActiveCallPresentation: Identifiable, Equatable {
    let id: UUID
    let callerName: String
    let connectedAt: Date
    let isLiveVoice: Bool
}

struct CallAudioRouteOption: Identifiable, Equatable {
    enum Kind: Equatable {
        case receiver
        case speaker
        case input(uid: String)
    }

    let id: String
    let name: String
    let systemImage: String
    let kind: Kind
}

@MainActor
final class CallCoordinator: NSObject, ObservableObject, @unchecked Sendable {
    private let provider: CXProvider
    private let callController = CXCallController()
    private let logger = Logger(subsystem: "com.chirag.agentcaller", category: "CallKit")
    private let speechSynthesizer = AVSpeechSynthesizer()
    private var audioPlayer: AVAudioPlayer?
    private var audioDownloadTask: Task<Void, Never>?
    private var calls: [UUID: IncomingCall] = [:]
    private var activeCallID: UUID?
    private var voiceSession: GrokVoiceSession?
    weak var configuration: ConnectionConfiguration?

    @Published private(set) var activeCall: ActiveCallPresentation?
    @Published private(set) var isMuted = false
    @Published private(set) var isSpeakerEnabled = false
    @Published private(set) var audioRouteName = "iPhone"
    @Published private(set) var availableAudioRoutes: [CallAudioRouteOption] = []

    override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        configuration.includesCallsInRecents = false
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: .main)
        speechSynthesizer.delegate = self
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(audioRouteDidChange),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
        refreshAudioRoutes()
    }

    func prepareMicrophonePermission() {
        guard AVAudioApplication.shared.recordPermission == .undetermined else { return }
        AVAudioApplication.requestRecordPermission { [logger] granted in
            if granted {
                logger.info("Microphone permission granted")
            } else {
                logger.error("Microphone permission denied; live calls will use the spoken-message fallback")
            }
        }
    }

    func reportIncoming(_ call: IncomingCall, completion: (@Sendable () -> Void)? = nil) {
        calls[call.id] = call
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: call.callerName)
        update.localizedCallerName = call.callerName
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false

        provider.reportNewIncomingCall(with: call.id, update: update) { [weak self] error in
            Task { @MainActor [weak self] in
                if let error {
                    #if DEBUG
                    print("CALLER_CALLKIT_REJECTED: \(error)")
                    #endif
                    self?.logger.error("Incoming call \(call.id, privacy: .public) rejected: \(error.localizedDescription, privacy: .public)")
                    self?.calls.removeValue(forKey: call.id)
                } else {
                    #if DEBUG
                    print("CALLER_CALLKIT_REPORTED: \(call.id)")
                    #endif
                    self?.logger.info("Incoming call \(call.id, privacy: .public) reported successfully")
                }
                completion?()
            }
        }
    }

    func providerDidReset(_ provider: CXProvider) {
        voiceSession?.stop()
        voiceSession = nil
        audioDownloadTask?.cancel()
        audioDownloadTask = nil
        audioPlayer?.stop()
        audioPlayer = nil
        speechSynthesizer.stopSpeaking(at: .immediate)
        calls.removeAll()
        activeCallID = nil
        resetCallPresentation()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let call = calls[action.callUUID] else {
            action.fail()
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                CallAudioRoutePolicy.category,
                mode: CallAudioRoutePolicy.mode,
                options: CallAudioRoutePolicy.options
            )
            activeCallID = call.id
            activeCall = ActiveCallPresentation(
                id: call.id,
                callerName: call.callerName,
                connectedAt: Date(),
                isLiveVoice: call.mode == .liveVoice
            )
            isMuted = false
            refreshAudioRoutes()
            action.fulfill()
        } catch {
            action.fail()
            provider.reportCall(with: action.callUUID, endedAt: Date(), reason: .failed)
        }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        voiceSession?.stop()
        voiceSession = nil
        audioDownloadTask?.cancel()
        audioDownloadTask = nil
        audioPlayer?.stop()
        audioPlayer = nil
        speechSynthesizer.stopSpeaking(at: .immediate)
        calls.removeValue(forKey: action.callUUID)
        if activeCallID == action.callUUID {
            activeCallID = nil
            resetCallPresentation()
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        guard activeCallID == action.callUUID else {
            action.fail()
            return
        }
        voiceSession?.setMuted(action.isMuted)
        isMuted = action.isMuted
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        refreshAudioRoutes()
        guard let activeCallID, let call = calls[activeCallID] else { return }
        if call.mode == .liveVoice {
            startLiveVoice(for: call)
        } else {
            playAudioOrFallback(for: call)
        }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        voiceSession?.stop()
        voiceSession = nil
        audioDownloadTask?.cancel()
        audioDownloadTask = nil
        audioPlayer?.stop()
        audioPlayer = nil
        speechSynthesizer.stopSpeaking(at: .immediate)
    }

    func toggleMute() {
        guard let activeCallID else { return }
        let action = CXSetMutedCallAction(call: activeCallID, muted: !isMuted)
        request(CXTransaction(action: action), failureMessage: "Could not change microphone mute")
    }

    func toggleSpeaker() {
        selectAudioRoute(isSpeakerEnabled ? .receiver : .speaker)
    }

    func selectAudioRoute(_ option: CallAudioRouteOption) {
        selectAudioRoute(option.kind)
    }

    func endActiveCall() {
        guard let activeCallID else { return }
        request(
            CXTransaction(action: CXEndCallAction(call: activeCallID)),
            failureMessage: "Could not end call"
        )
    }

    private func startLiveVoice(for call: IncomingCall) {
        guard AVAudioApplication.shared.recordPermission == .granted else {
            logger.error("Live voice unavailable because microphone permission is not granted")
            playAudioOrFallback(for: call)
            return
        }
        guard let configuration,
              let relayURL = configuration.validatedRelayURL,
              let installationID = configuration.installationID,
              let installationSecret = configuration.installationSecret else {
            logger.error("Live voice unavailable because Caller credentials are missing")
            playAudioOrFallback(for: call)
            return
        }
        let voiceSession = GrokVoiceSession()
        voiceSession.onFailure = { [weak self] _ in
            guard let self, self.activeCallID == call.id else { return }
            self.voiceSession?.stop()
            self.voiceSession = nil
            self.playAudioOrFallback(for: call)
        }
        self.voiceSession = voiceSession
        voiceSession.start(
            callID: call.id,
            client: VoiceBootstrapClient(
                relayURL: relayURL,
                installationID: installationID,
                installationSecret: installationSecret
            )
        )
    }

    private func playAudioOrFallback(for call: IncomingCall) {
        guard let request = call.audioRequest else {
            speak(call.message)
            return
        }
        audioDownloadTask?.cancel()
        audioDownloadTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                try Task.checkCancellation()
                guard let http = response as? HTTPURLResponse,
                      (200..<300).contains(http.statusCode),
                      !data.isEmpty else {
                    throw URLError(.badServerResponse)
                }
                guard self.activeCallID == call.id else { return }
                let player = try AVAudioPlayer(data: data)
                player.delegate = self
                guard player.prepareToPlay(), player.play() else {
                    throw URLError(.cannotDecodeContentData)
                }
                self.audioPlayer = player
            } catch is CancellationError {
                return
            } catch {
                guard self.activeCallID == call.id else { return }
                self.logger.error("Audio message failed; using speech fallback: \(error.localizedDescription, privacy: .public)")
                self.speak(call.message)
            }
        }
    }

    private func speak(_ message: String) {
        let utterance = AVSpeechUtterance(string: message)
        utterance.rate = 0.48
        utterance.voice = AVSpeechSynthesisVoice(language: "en-IN") ?? AVSpeechSynthesisVoice(language: "en-US")
        speechSynthesizer.speak(utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        finishActiveCall()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        audioPlayer = nil
        finishActiveCall()
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
        audioPlayer = nil
        guard let activeCallID, let call = calls[activeCallID] else { return }
        logger.error("Audio message decode failed; using speech fallback: \(error?.localizedDescription ?? "unknown error", privacy: .public)")
        speak(call.message)
    }

    private func finishActiveCall() {
        guard let id = activeCallID else { return }
        voiceSession?.stop()
        voiceSession = nil
        provider.reportCall(with: id, endedAt: Date(), reason: .remoteEnded)
        calls.removeValue(forKey: id)
        activeCallID = nil
        resetCallPresentation()
    }

    private func request(_ transaction: CXTransaction, failureMessage: String) {
        callController.request(transaction) { [weak self] error in
            guard let error else { return }
            Task { @MainActor [weak self] in
                self?.logger.error("\(failureMessage, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func selectAudioRoute(_ kind: CallAudioRouteOption.Kind) {
        let session = AVAudioSession.sharedInstance()
        do {
            switch kind {
            case .speaker:
                try session.setPreferredInput(session.availableInputs?.first(where: { $0.portType == .builtInMic }))
                try session.overrideOutputAudioPort(.speaker)
            case .receiver:
                try session.setPreferredInput(session.availableInputs?.first(where: { $0.portType == .builtInMic }))
                try session.overrideOutputAudioPort(.none)
            case .input(let uid):
                guard let input = session.availableInputs?.first(where: { $0.uid == uid }) else { return }
                try session.overrideOutputAudioPort(.none)
                try session.setPreferredInput(input)
            }
            refreshAudioRoutes()
        } catch {
            logger.error("Audio route change failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    @objc private func audioRouteDidChange() {
        refreshAudioRoutes()
    }

    private func refreshAudioRoutes() {
        let session = AVAudioSession.sharedInstance()
        let output = session.currentRoute.outputs.first
        isSpeakerEnabled = output?.portType == .builtInSpeaker
        audioRouteName = output?.portName ?? (isSpeakerEnabled ? "Speaker" : "iPhone")

        var routes = [
            CallAudioRouteOption(id: "receiver", name: "iPhone", systemImage: "iphone", kind: .receiver),
            CallAudioRouteOption(id: "speaker", name: "Speaker", systemImage: "speaker.wave.3.fill", kind: .speaker),
        ]
        for input in session.availableInputs ?? [] where input.portType != .builtInMic {
            routes.append(CallAudioRouteOption(
                id: input.uid,
                name: input.portName,
                systemImage: input.portType == .headsetMic ? "headphones" : "airpodspro",
                kind: .input(uid: input.uid)
            ))
        }
        availableAudioRoutes = routes
    }

    private func resetCallPresentation() {
        activeCall = nil
        isMuted = false
        isSpeakerEnabled = false
        audioRouteName = "iPhone"
        availableAudioRoutes = []
    }
}

extension CallCoordinator: @preconcurrency CXProviderDelegate, @preconcurrency AVSpeechSynthesizerDelegate, @preconcurrency AVAudioPlayerDelegate {}
