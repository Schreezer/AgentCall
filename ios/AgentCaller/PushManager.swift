import Foundation
import PushKit
import UIKit

@MainActor
final class PushManager: NSObject, @preconcurrency PKPushRegistryDelegate {
    weak var configuration: ConnectionConfiguration?
    let approvalStore = HermesApprovalStore()

    private let callCoordinator: CallCoordinator
    private let urlSession: URLSession
    private var registry: PKPushRegistry?
    private var token: String?
    private var alertToken: String?
    private var registrationTask: Task<Void, Never>?
    private var registrationAttemptID: UUID?
    private var registrationRequestedWhileRunning = false
    private var relayChangeInProgress = false
    private var pairingCodeTask: Task<Void, Never>?
    private var pairingCodeTaskID: UUID?
    private var pairingStatusTask: Task<Void, Never>?
    private var pairingStatusTaskID: UUID?

    init(callCoordinator: CallCoordinator, urlSession: URLSession = .shared) {
        self.callCoordinator = callCoordinator
        self.urlSession = urlSession
    }

    func start() {
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--demo-") }) {
            return
        }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry
    }

    func registerCurrentTokenIfPossible() {
        guard let configuration else { return }
        guard !relayChangeInProgress else {
            registrationRequestedWhileRunning = true
            return
        }
        guard let relayURL = configuration.validatedRelayURL else {
            configuration.markFailed("The Caller relay URL is invalid")
            return
        }
        if registrationTask != nil {
            registrationRequestedWhileRunning = true
            return
        }
        if resumePendingRelayTransitionIfNeeded(configuration: configuration) {
            return
        }
        guard let token else {
            configuration.markWaitingForPushToken()
            return
        }
        configuration.markPushTokenAvailable()
        configuration.markConnecting()
        let relayGeneration = configuration.relayGeneration

        let existingInstallationID = configuration.installationID
        let existingInstallationSecret = configuration.installationSecret
        let isUpdatingExistingInstallation = existingInstallationID != nil
            && existingInstallationSecret != nil
        guard let registrationIdentity = configuration.deviceIdentityForRegistration(
            allowLegacyRecovery: !isUpdatingExistingInstallation
        ) else {
            configuration.markFailed("Caller could not save its secure connection identity")
            return
        }
        let body = DeviceRegistration(
            token: token,
            alertToken: alertToken,
            deviceIdentity: registrationIdentity.value,
            platform: "ios",
            environment: isDebugBuild ? "sandbox" : "production",
            deviceName: UIDevice.current.name
        )
        var request: URLRequest
        if let installationID = existingInstallationID,
           let installationSecret = existingInstallationSecret {
            request = URLRequest(url: relayURL.appending(path: "v1/installations/\(installationID)/device"))
            request.httpMethod = "PUT"
            request.setValue("Bearer \(installationSecret)", forHTTPHeaderField: "Authorization")
        } else {
            request = URLRequest(url: relayURL.appending(path: "v1/installations"))
            request.httpMethod = "POST"
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(body)

        let attemptID = UUID()
        registrationAttemptID = attemptID
        registrationTask = Task { [weak self] in
            guard let self else { return }
            defer { self.finishRegistrationAttempt(attemptID: attemptID) }
            do {
                let (data, response) = try await self.urlSession.data(for: request)
                guard configuration.isCurrentRelayGeneration(relayGeneration) else { return }
                guard let http = response as? HTTPURLResponse else {
                    configuration.markFailed("Caller relay returned an invalid response")
                    return
                }
                if http.statusCode == 401 && isUpdatingExistingInstallation {
                    guard configuration.prepareForInstallationRecovery() else { return }
                    self.registrationRequestedWhileRunning = true
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    configuration.markFailed("Caller relay rejected this iPhone")
                    return
                }
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                guard configuration.applyRegistration(
                    try decoder.decode(InstallationRegistration.self, from: data)
                ) else { return }
                if registrationIdentity.usesLegacyRecoveryIdentity {
                    self.registrationRequestedWhileRunning = true
                } else {
                    _ = configuration.markDeviceIdentityRegistered(registrationIdentity)
                }
            } catch {
                if Task.isCancelled { return }
                configuration.markFailed("Could not reach the Caller relay")
            }
        }
    }

    private func finishRegistrationAttempt(attemptID: UUID) {
        guard registrationAttemptID == attemptID else { return }
        registrationTask = nil
        registrationAttemptID = nil
        guard !relayChangeInProgress else { return }
        guard registrationRequestedWhileRunning else { return }
        registrationRequestedWhileRunning = false
        registerCurrentTokenIfPossible()
    }

    private func resumePendingRelayTransitionIfNeeded(
        configuration: ConnectionConfiguration
    ) -> Bool {
        guard let transition = configuration.pendingRelayTransition else { return false }
        guard let previousRelayURL = configuration.validatedRelayURL(
            for: transition.previousRelayURL
        ) else {
            registrationRequestedWhileRunning = false
            configuration.markFailed("Caller could not resume its previous relay cleanup")
            return true
        }

        configuration.markCleaningPreviousRelay()
        let relayGeneration = configuration.relayGeneration
        var request = URLRequest(
            url: previousRelayURL.appending(
                path: "v1/installations/\(transition.previousInstallationID)"
            )
        )
        request.httpMethod = "DELETE"
        request.setValue(
            "Bearer \(transition.previousInstallationSecret)",
            forHTTPHeaderField: "Authorization"
        )
        let attemptID = UUID()
        registrationAttemptID = attemptID
        registrationTask = Task { [weak self] in
            guard let self else { return }
            defer { self.finishRegistrationAttempt(attemptID: attemptID) }
            do {
                let (_, response) = try await self.urlSession.data(for: request)
                guard !Task.isCancelled,
                      configuration.isCurrentRelayGeneration(relayGeneration),
                      let http = response as? HTTPURLResponse,
                      (200..<300).contains(http.statusCode)
                        || http.statusCode == 401
                        || http.statusCode == 404 else {
                    self.registrationRequestedWhileRunning = false
                    configuration.markFailed("Could not finish disconnecting from the previous relay")
                    return
                }
                guard configuration.clearPendingRelayTransition() else {
                    self.registrationRequestedWhileRunning = false
                    return
                }
                self.registrationRequestedWhileRunning = true
            } catch {
                if Task.isCancelled { return }
                self.registrationRequestedWhileRunning = false
                configuration.markFailed("Could not finish disconnecting from the previous relay")
            }
        }
        return true
    }

    func createPairingCode() {
        guard !relayChangeInProgress else { return }
        guard let configuration,
              let relayURL = configuration.validatedRelayURL,
              let installationID = configuration.installationID,
              let installationSecret = configuration.installationSecret else { return }
        configuration.markConnecting()
        var request = URLRequest(url: relayURL.appending(path: "v1/installations/\(installationID)/pairing-code"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(installationSecret)", forHTTPHeaderField: "Authorization")
        let relayGeneration = configuration.relayGeneration
        pairingCodeTask?.cancel()
        let taskID = UUID()
        pairingCodeTaskID = taskID
        pairingCodeTask = Task { [weak self] in
            guard let self else { return }
            defer { self.finishPairingCodeTask(taskID: taskID) }
            do {
                let (data, response) = try await self.urlSession.data(for: request)
                guard !Task.isCancelled,
                      configuration.isCurrentRelayGeneration(relayGeneration) else { return }
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    configuration.markFailed("Could not create a new pairing code")
                    return
                }
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                _ = configuration.applyRegistration(
                    try decoder.decode(InstallationRegistration.self, from: data)
                )
            } catch {
                guard !Task.isCancelled,
                      configuration.isCurrentRelayGeneration(relayGeneration) else { return }
                configuration.markFailed("Could not reach the Caller relay")
            }
        }
    }

    func changeRelay(to candidate: String) async -> Bool {
        guard let configuration,
              configuration.validatedRelayURL(for: candidate) != nil else {
            configuration?.markFailed("Enter a valid HTTPS relay URL")
            return false
        }
        guard !relayChangeInProgress else { return false }
        guard configuration.pendingRelayTransition == nil else {
            configuration.markFailed("Finish disconnecting from the previous relay before changing again")
            return false
        }
        relayChangeInProgress = true
        var shouldRestartRegistration = false
        defer { finishRelayChange(restartRegistration: shouldRestartRegistration) }

        await cancelRelayScopedTasksForRelayChange()

        let isChangingRelay = configuration.wouldChangeRelay(to: candidate)
        let previousConnection = configuration.relayConnectionSnapshot()
        if isChangingRelay,
           !configuration.prepareRelayTransition(from: previousConnection, to: candidate) {
            return false
        }
        guard configuration.updateRelayURL(candidate) else {
            if isChangingRelay { _ = configuration.clearPendingRelayTransition() }
            return false
        }

        if isChangingRelay,
           let currentRelayURL = configuration.validatedRelayURL(
               for: previousConnection.relayURL
           ),
           let installationID = previousConnection.installationID,
           let installationSecret = previousConnection.installationSecret {
            var request = URLRequest(url: currentRelayURL.appending(path: "v1/installations/\(installationID)"))
            request.httpMethod = "DELETE"
            request.setValue("Bearer \(installationSecret)", forHTTPHeaderField: "Authorization")
            do {
                let (_, response) = try await urlSession.data(for: request)
                guard let http = response as? HTTPURLResponse,
                      (200..<300).contains(http.statusCode)
                        || http.statusCode == 401
                        || http.statusCode == 404 else {
                    let restored = configuration.restoreRelayConnection(previousConnection)
                    if restored, configuration.clearPendingRelayTransition() {
                        configuration.markFailed("Could not disconnect from the current relay")
                    }
                    return false
                }
            } catch {
                let restored = configuration.restoreRelayConnection(previousConnection)
                if restored, configuration.clearPendingRelayTransition() {
                    configuration.markFailed("Could not disconnect from the current relay")
                }
                return false
            }
        }

        if isChangingRelay,
           !configuration.clearPendingRelayTransition() {
            return false
        }
        shouldRestartRegistration = true
        return true
    }

    private func cancelRelayScopedTasksForRelayChange() async {
        registrationRequestedWhileRunning = false
        let cancelledRegistrationAttemptID = registrationAttemptID
        let registrationTask = registrationTask
        let cancelledPairingCodeTaskID = pairingCodeTaskID
        let pairingCodeTask = pairingCodeTask
        let cancelledPairingStatusTaskID = pairingStatusTaskID
        let pairingStatusTask = pairingStatusTask
        registrationTask?.cancel()
        pairingCodeTask?.cancel()
        pairingStatusTask?.cancel()
        await registrationTask?.value
        await pairingCodeTask?.value
        await pairingStatusTask?.value
        if self.registrationAttemptID == cancelledRegistrationAttemptID {
            self.registrationTask = nil
            self.registrationAttemptID = nil
        }
        if self.pairingCodeTaskID == cancelledPairingCodeTaskID {
            self.pairingCodeTask = nil
            self.pairingCodeTaskID = nil
        }
        if self.pairingStatusTaskID == cancelledPairingStatusTaskID {
            self.pairingStatusTask = nil
            self.pairingStatusTaskID = nil
        }
    }

    private func finishRelayChange(restartRegistration: Bool) {
        relayChangeInProgress = false
        registrationRequestedWhileRunning = false
        if restartRegistration {
            registerCurrentTokenIfPossible()
        }
    }

    private func finishPairingCodeTask(taskID: UUID) {
        guard pairingCodeTaskID == taskID else { return }
        pairingCodeTask = nil
        pairingCodeTaskID = nil
    }

    private func finishPairingStatusTask(taskID: UUID) {
        guard pairingStatusTaskID == taskID else { return }
        pairingStatusTask = nil
        pairingStatusTaskID = nil
    }

    func refreshPairingStatus() {
        guard !relayChangeInProgress else { return }
        guard let configuration,
              let relayURL = configuration.validatedRelayURL,
              let installationID = configuration.installationID,
              let installationSecret = configuration.installationSecret else { return }
        var request = URLRequest(url: relayURL.appending(path: "v1/installations/\(installationID)"))
        request.setValue("Bearer \(installationSecret)", forHTTPHeaderField: "Authorization")
        let relayGeneration = configuration.relayGeneration
        pairingStatusTask?.cancel()
        let taskID = UUID()
        pairingStatusTaskID = taskID
        pairingStatusTask = Task { [weak self] in
            guard let self else { return }
            defer { self.finishPairingStatusTask(taskID: taskID) }
            do {
                let (data, response) = try await self.urlSession.data(for: request)
                guard !Task.isCancelled,
                      configuration.isCurrentRelayGeneration(relayGeneration) else { return }
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return }
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                _ = configuration.applyRegistration(
                    try decoder.decode(InstallationRegistration.self, from: data)
                )
            } catch {
                // A transient status refresh must not replace a working pairing screen with an error.
            }
        }
    }

    func didRegisterAlertToken(_ data: Data) {
        alertToken = data.map { String(format: "%02x", $0) }.joined()
        registerCurrentTokenIfPossible()
    }

    func didFailToRegisterAlertToken(_ error: Error) {
        // VoIP calls remain available. The approval inbox is refreshed whenever the app opens.
    }

    func didReceiveAlertNotification(
        _ userInfo: [AnyHashable: Any],
        completion: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard userInfo["event"] as? String == "hermes_approval_required" else {
            completion(.noData)
            return
        }
        approvalStore.refresh()
        completion(.newData)
    }

    func refreshApprovals() {
        approvalStore.configuration = configuration
        approvalStore.refresh()
    }

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        didReceiveVoIPToken(pushCredentials.token)
    }

    func didReceiveVoIPToken(_ data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        configuration?.markPushTokenAvailable()
        registerCurrentTokenIfPossible()
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        token = nil
        configuration?.markPushTokenUnavailable()
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        let dictionary = payload.dictionaryPayload
        let audioRequest = CallAudioRequestFactory.make(
            payload: dictionary,
            relayURL: configuration?.validatedRelayURL,
            installationID: configuration?.installationID,
            installationSecret: configuration?.installationSecret
        )
        guard type == .voIP,
              let call = IncomingCall(payload: dictionary, audioRequest: audioRequest) else {
            completion()
            return
        }
        let completionBox = PushCompletion(completion)
        callCoordinator.reportIncoming(call) { completionBox.call() }
    }

    private var isDebugBuild: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }
}

private final class PushCompletion: @unchecked Sendable {
    private let completion: () -> Void
    init(_ completion: @escaping () -> Void) { self.completion = completion }
    func call() { completion() }
}

private struct DeviceRegistration: Encodable {
    let token: String
    let alertToken: String?
    let deviceIdentity: String
    let platform: String
    let environment: String
    let deviceName: String

    enum CodingKeys: String, CodingKey {
        case token, platform, environment
        case alertToken = "alert_token"
        case deviceIdentity = "device_identity"
        case deviceName = "device_name"
    }
}
