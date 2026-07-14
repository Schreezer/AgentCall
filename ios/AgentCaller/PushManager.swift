import Foundation
import PushKit
import UIKit

@MainActor
final class PushManager: NSObject, @preconcurrency PKPushRegistryDelegate {
    weak var configuration: ConnectionConfiguration?

    private let callCoordinator: CallCoordinator
    private var registry: PKPushRegistry?
    private var token: String?

    init(callCoordinator: CallCoordinator) {
        self.callCoordinator = callCoordinator
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
        guard let relayURL = configuration.validatedRelayURL else {
            configuration.markFailed("The Caller relay URL is invalid")
            return
        }
        guard let token else {
            configuration.markWaitingForPushToken()
            return
        }
        configuration.markPushTokenAvailable()
        configuration.markConnecting()

        let body = DeviceRegistration(
            token: token,
            platform: "ios",
            environment: isDebugBuild ? "sandbox" : "production",
            deviceName: UIDevice.current.name
        )
        var request: URLRequest
        if let installationID = configuration.installationID,
           let installationSecret = configuration.installationSecret {
            request = URLRequest(url: relayURL.appending(path: "v1/installations/\(installationID)/device"))
            request.httpMethod = "PUT"
            request.setValue("Bearer \(installationSecret)", forHTTPHeaderField: "Authorization")
        } else {
            request = URLRequest(url: relayURL.appending(path: "v1/installations"))
            request.httpMethod = "POST"
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(body)

        Task {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    configuration.markFailed("Caller relay rejected this iPhone")
                    return
                }
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                configuration.applyRegistration(try decoder.decode(InstallationRegistration.self, from: data))
            } catch {
                configuration.markFailed("Could not reach the Caller relay")
            }
        }
    }

    func createPairingCode() {
        guard let configuration,
              let relayURL = configuration.validatedRelayURL,
              let installationID = configuration.installationID,
              let installationSecret = configuration.installationSecret else { return }
        configuration.markConnecting()
        var request = URLRequest(url: relayURL.appending(path: "v1/installations/\(installationID)/pairing-code"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(installationSecret)", forHTTPHeaderField: "Authorization")
        Task {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    configuration.markFailed("Could not create a new pairing code")
                    return
                }
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                configuration.applyRegistration(try decoder.decode(InstallationRegistration.self, from: data))
            } catch {
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

        let isChangingRelay = configuration.wouldChangeRelay(to: candidate)
        if isChangingRelay,
           let currentRelayURL = configuration.validatedRelayURL,
           let installationID = configuration.installationID,
           let installationSecret = configuration.installationSecret {
            var request = URLRequest(url: currentRelayURL.appending(path: "v1/installations/\(installationID)"))
            request.httpMethod = "DELETE"
            request.setValue("Bearer \(installationSecret)", forHTTPHeaderField: "Authorization")
            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse,
                      (200..<300).contains(http.statusCode) || http.statusCode == 401 else {
                    configuration.markFailed("Could not disconnect from the current relay")
                    return false
                }
            } catch {
                configuration.markFailed("Could not disconnect from the current relay")
                return false
            }
        }

        guard configuration.updateRelayURL(candidate) else { return false }
        registerCurrentTokenIfPossible()
        return true
    }

    func refreshPairingStatus() {
        guard let configuration,
              let relayURL = configuration.validatedRelayURL,
              let installationID = configuration.installationID,
              let installationSecret = configuration.installationSecret else { return }
        var request = URLRequest(url: relayURL.appending(path: "v1/installations/\(installationID)"))
        request.setValue("Bearer \(installationSecret)", forHTTPHeaderField: "Authorization")
        Task {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return }
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                configuration.applyRegistration(try decoder.decode(InstallationRegistration.self, from: data))
            } catch {
                // A transient status refresh must not replace a working pairing screen with an error.
            }
        }
    }

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
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
    let platform: String
    let environment: String
    let deviceName: String

    enum CodingKeys: String, CodingKey {
        case token, platform, environment
        case deviceName = "device_name"
    }
}
