@preconcurrency import AVFoundation
@preconcurrency import CallKit
import OSLog

@MainActor
final class CallCoordinator: NSObject, @unchecked Sendable {
    private let provider: CXProvider
    private let logger = Logger(subsystem: "com.chirag.agentcaller", category: "CallKit")
    private let speechSynthesizer = AVSpeechSynthesizer()
    private var audioPlayer: AVAudioPlayer?
    private var audioDownloadTask: Task<Void, Never>?
    private var calls: [UUID: IncomingCall] = [:]
    private var activeCallID: UUID?
    private var voiceSession: GrokVoiceSession?
    weak var configuration: ConnectionConfiguration?

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
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let call = calls[action.callUUID] else {
            action.fail()
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
            activeCallID = call.id
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
        if activeCallID == action.callUUID { activeCallID = nil }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
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
    }
}

extension CallCoordinator: @preconcurrency CXProviderDelegate, @preconcurrency AVSpeechSynthesizerDelegate, @preconcurrency AVAudioPlayerDelegate {}
