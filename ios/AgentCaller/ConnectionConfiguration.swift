import Foundation

@MainActor
final class ConnectionConfiguration: ObservableObject {
    enum State: Equatable {
        case notConfigured
        case waitingForPushToken
        case connecting
        case connected
        case failed(String)
    }

    enum HomeState: Equatable {
        case preparing
        case readyToPair
        case waitingForPairing
        case paired
        case needsAttention(String)
    }

    @Published private(set) var relayURL: String
    @Published private(set) var state: State = .notConfigured
    @Published private(set) var hasPushToken = false
    @Published private(set) var pairingCode: String?
    @Published private(set) var pairingExpiresAt: Date?
    @Published private(set) var agentPaired = false

    let defaultRelayURL: String

    private let defaults: UserDefaults
    private let credentials: CredentialStoring
    private static let relayURLKey = "agentCaller.relayURL"
    private static let installationIDKey = "agentCaller.installationID"
    private static let installationSecretKey = "installation-secret"
    private static let legacyPlaceholderURL = "https://push.caller.example"
    private static let fallbackRelayURL = "https://push.caller.example"

    init(
        defaults: UserDefaults = .standard,
        credentials: CredentialStoring = KeychainCredentialStore(),
        defaultRelayURL: String? = nil
    ) {
        self.defaults = defaults
        self.credentials = credentials
        let bundledURL = defaultRelayURL ?? Bundle.main.object(forInfoDictionaryKey: "CallerRelayURL") as? String
        self.defaultRelayURL = bundledURL ?? Self.fallbackRelayURL

        let storedURL = defaults.string(forKey: Self.relayURLKey)
        if storedURL == nil
            || storedURL == Self.legacyPlaceholderURL {
            relayURL = self.defaultRelayURL
            defaults.set(self.defaultRelayURL, forKey: Self.relayURLKey)
        } else {
            relayURL = storedURL ?? self.defaultRelayURL
        }

        let launchArguments = ProcessInfo.processInfo.arguments
        if launchArguments.contains("--demo-paired") {
            hasPushToken = true
            agentPaired = true
            state = .connected
        } else if launchArguments.contains("--demo-pairing") {
            pairingCode = "HERM-3S26"
            pairingExpiresAt = Date().addingTimeInterval(15 * 60)
            hasPushToken = true
            state = .connected
        } else if launchArguments.contains("--demo-error") {
            hasPushToken = true
            state = .failed("The Caller relay could not register this iPhone")
        } else if launchArguments.contains("--demo-preparing") {
            state = .connecting
        } else if validatedRelayURL != nil {
            state = .waitingForPushToken
        }
    }

    var validatedRelayURL: URL? {
        validatedRelayURL(for: relayURL)
    }

    var installationID: String? { defaults.string(forKey: Self.installationIDKey) }
    var installationSecret: String? { credentials.string(for: Self.installationSecretKey) }
    var isReadyForAgentSetup: Bool { state == .connected && hasPushToken }
    var isUsingDefaultRelay: Bool { normalizedURLString(relayURL) == normalizedURLString(defaultRelayURL) }

    var statusText: String {
        switch state {
        case .notConfigured: "Relay needs attention"
        case .waitingForPushToken: "Preparing incoming calls…"
        case .connecting: "Connecting to Caller relay…"
        case .connected where agentPaired: "Agent paired and ready"
        case .connected: "iPhone ready to pair"
        case .failed(let message): message
        }
    }

    func validatedRelayURL(for candidate: String) -> URL? {
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || isLocalDevelopmentURL(url) else {
            return nil
        }
        return url
    }

    func wouldChangeRelay(to candidate: String) -> Bool {
        guard let validatedURL = validatedRelayURL(for: candidate) else { return false }
        return normalizedURLString(validatedURL.absoluteString) != normalizedURLString(relayURL)
    }

    @discardableResult
    func updateRelayURL(_ candidate: String) -> Bool {
        guard let validatedURL = validatedRelayURL(for: candidate) else {
            state = .failed("Enter a valid HTTPS relay URL")
            return false
        }

        let updatedURL = normalizedURLString(validatedURL.absoluteString)
        let changed = updatedURL != normalizedURLString(relayURL)
        relayURL = updatedURL
        defaults.set(relayURL, forKey: Self.relayURLKey)

        if changed {
            clearInstallationCredentials()
            pairingCode = nil
            pairingExpiresAt = nil
            agentPaired = false
            state = .waitingForPushToken
        }
        return true
    }

    @discardableResult
    func restoreDefaultRelayURL() -> Bool {
        updateRelayURL(defaultRelayURL)
    }

    func applyRegistration(_ registration: InstallationRegistration) {
        defaults.set(registration.installationID, forKey: Self.installationIDKey)
        if let secret = registration.installationSecret {
            _ = credentials.set(secret, for: Self.installationSecretKey)
        }
        pairingCode = registration.pairingCode
        pairingExpiresAt = registration.pairingExpiresAt
        agentPaired = registration.paired
        hasPushToken = true
        state = .connected
    }

    func markPushTokenAvailable() {
        hasPushToken = true
        if state != .connected { state = .waitingForPushToken }
    }

    func markPushTokenUnavailable() {
        hasPushToken = false
        state = .waitingForPushToken
    }

    func markWaitingForPushToken() {
        if !hasPushToken { state = .waitingForPushToken }
    }

    func markConnecting() {
        hasPushToken = true
        state = .connecting
    }

    func markConnected() { state = .connected }
    func markFailed(_ message: String) { state = .failed(message) }

    func hasUsablePairingCode(at date: Date = Date()) -> Bool {
        guard pairingCode != nil else { return false }
        guard let pairingExpiresAt else { return true }
        return pairingExpiresAt > date
    }

    func homeState(at date: Date = Date()) -> HomeState {
        if case .failed(let message) = state {
            return .needsAttention(message)
        }
        guard isReadyForAgentSetup else { return .preparing }
        if hasUsablePairingCode(at: date) { return .waitingForPairing }
        return agentPaired ? .paired : .readyToPair
    }

    private func clearInstallationCredentials() {
        defaults.removeObject(forKey: Self.installationIDKey)
        _ = credentials.remove(Self.installationSecretKey)
    }

    private func normalizedURLString(_ value: String) -> String {
        value.trimmingCharacters(in: CharacterSet(charactersIn: "/").union(.whitespacesAndNewlines))
    }

    private func isLocalDevelopmentURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "http" else { return false }
        return ["localhost", "127.0.0.1"].contains(url.host?.lowercased() ?? "")
    }
}

struct InstallationRegistration: Decodable {
    let installationID: String
    let installationSecret: String?
    let paired: Bool
    let pairingCode: String?
    let pairingExpiresAt: Date?

    enum CodingKeys: String, CodingKey {
        case installationID = "installation_id"
        case installationSecret = "installation_secret"
        case paired
        case pairingCode = "pairing_code"
        case pairingExpiresAt = "pairing_expires_at"
    }
}
