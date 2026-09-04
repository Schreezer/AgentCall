import Foundation

@MainActor
final class ConnectionConfiguration: ObservableObject {
    struct RegistrationDeviceIdentity: Equatable {
        let value: String
        let usesLegacyRecoveryIdentity: Bool
    }

    struct RelayConnectionSnapshot {
        let relayURL: String
        let installationID: String?
        let installationSecret: String?
        let pairingCode: String?
        let pairingExpiresAt: Date?
        let agentPaired: Bool
        let state: State
    }

    struct PendingRelayTransition: Codable, Equatable {
        let previousRelayURL: String
        let previousInstallationID: String
        let previousInstallationSecret: String
        let candidateRelayOrigin: String
    }

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
        case hostedAssistant
        case needsAttention(String)
    }

    enum AgentMode: String, Equatable {
        case external
        case hosted
    }

    @Published private(set) var relayURL: String
    @Published private(set) var state: State = .notConfigured
    @Published private(set) var hasPushToken = false
    @Published private(set) var pairingCode: String?
    @Published private(set) var pairingExpiresAt: Date?
    @Published private(set) var agentPaired = false
    @Published private(set) var agentMode: AgentMode = .external
    private(set) var relayGeneration = 0
    private var relayURLIsDurablyStored = false

    let defaultRelayURL: String

    private let defaults: UserDefaults
    private let credentials: CredentialStoring
    private static let relayURLKey = "agentCaller.relayURL"
    private static let installationIDKey = "agentCaller.installationID"
    private static let relayURLCredentialKey = "relay-url"
    private static let installationIDCredentialKey = "installation-id"
    private static let installationSecretKey = "installation-secret"
    private static let installationCredentialKey = "installation-credential-v3"
    private static let legacyInstallationCredentialKey = "installation-credential-v2"
    private static let pendingRelayTransitionKey = "pending-relay-transition-v1"
    private static let legacyDeviceIdentityKey = "device-identity"
    private static let legacyDeviceIdentityOriginKey = "device-identity-legacy-origin"
    private static let legacyDeviceIdentityRetiredCredentialKey = "device-identity-legacy-retired"
    private static let scopedDeviceIdentityKeyPrefix = "device-identity-origin-"
    private static let legacyDeviceIdentityRetiredKey = "agentCaller.legacyDeviceIdentityRetired"
    private static let legacyPlaceholderURL = "https://push.caller.example"
    private static let legacyMacRelayURL = "https://macbook-pro-4.tail38a470.ts.net"
    private static let fallbackRelayURL = "https://agentcall-relay.chiragmgg.workers.dev"

    init(
        defaults: UserDefaults = .standard,
        credentials: CredentialStoring = KeychainCredentialStore(),
        defaultRelayURL: String? = nil
    ) {
        self.defaults = defaults
        self.credentials = credentials
        let bundledURL = defaultRelayURL ?? Bundle.main.object(forInfoDictionaryKey: "CallerRelayURL") as? String
        self.defaultRelayURL = bundledURL ?? Self.fallbackRelayURL

        let storedURL = credentials.string(for: Self.relayURLCredentialKey)
            ?? defaults.string(forKey: Self.relayURLKey)
        let selectedRelayURL: String
        if storedURL == nil || storedURL.map(Self.isLegacyRelayURL) == true {
            selectedRelayURL = self.defaultRelayURL
        } else {
            selectedRelayURL = storedURL ?? self.defaultRelayURL
        }
        relayURL = Self.normalizedURLString(selectedRelayURL)
        relayURLIsDurablyStored = persistRelayURL(relayURL)
        if relayURLIsDurablyStored {
            defaults.set(relayURL, forKey: Self.relayURLKey)
        }

        if let installationID = storedInstallationCredential?.installationID {
            defaults.set(installationID, forKey: Self.installationIDKey)
        } else {
            defaults.removeObject(forKey: Self.installationIDKey)
        }
        bindLegacyDeviceIdentityToCurrentOriginIfNeeded()

        let launchArguments = ProcessInfo.processInfo.arguments
        if !relayURLIsDurablyStored {
            state = .failed("Caller could not securely save its relay URL")
        } else if launchArguments.contains("--demo-paired") {
            hasPushToken = true
            agentPaired = true
            state = .connected
        } else if launchArguments.contains("--demo-hosted") {
            hasPushToken = true
            agentMode = .hosted
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
        guard relayURLIsDurablyStored else { return nil }
        return validatedRelayURL(for: relayURL)
    }

    var installationID: String? {
        storedInstallationCredential?.installationID
    }
    var installationSecret: String? {
        storedInstallationCredential?.installationSecret
    }
    func deviceIdentityForRegistration(
        allowLegacyRecovery: Bool
    ) -> RegistrationDeviceIdentity? {
        if allowLegacyRecovery,
           !legacyDeviceIdentityIsRetired,
           let identity = credentials.string(for: Self.legacyDeviceIdentityKey),
           Self.isValidDeviceIdentity(identity) {
            guard let boundOrigin = credentials.string(
                for: Self.legacyDeviceIdentityOriginKey
            ) else {
                return nil
            }
            if boundOrigin == recoveryOrigin {
                return RegistrationDeviceIdentity(
                    value: identity,
                    usesLegacyRecoveryIdentity: true
                )
            }
        }
        guard let key = scopedDeviceIdentityCredentialKey else { return nil }
        if let identity = credentials.string(for: key),
           Self.isValidDeviceIdentity(identity) {
            return RegistrationDeviceIdentity(
                value: identity,
                usesLegacyRecoveryIdentity: false
            )
        }
        let identity = [UUID(), UUID()]
            .map { $0.uuidString.replacingOccurrences(of: "-", with: "").lowercased() }
            .joined()
        guard credentials.set(identity, for: key),
              credentials.string(for: key) == identity else {
            return nil
        }
        return RegistrationDeviceIdentity(
            value: identity,
            usesLegacyRecoveryIdentity: false
        )
    }

    @discardableResult
    func markDeviceIdentityRegistered(_ identity: RegistrationDeviceIdentity) -> Bool {
        guard !identity.usesLegacyRecoveryIdentity else { return true }
        let retiredValue = "true"
        guard credentials.set(
            retiredValue,
            for: Self.legacyDeviceIdentityRetiredCredentialKey
        ), credentials.string(for: Self.legacyDeviceIdentityRetiredCredentialKey) == retiredValue else {
            state = .failed("Caller could not retire its previous secure identity")
            return false
        }
        _ = credentials.remove(Self.legacyDeviceIdentityKey)
        _ = credentials.remove(Self.legacyDeviceIdentityOriginKey)
        guard credentials.string(for: Self.legacyDeviceIdentityKey) == nil,
              credentials.string(for: Self.legacyDeviceIdentityOriginKey) == nil else {
            state = .failed("Caller could not retire its previous secure identity")
            return false
        }
        defaults.set(true, forKey: Self.legacyDeviceIdentityRetiredKey)
        return true
    }
    var isReadyForAgentSetup: Bool { state == .connected && hasPushToken }
    var isUsingDefaultRelay: Bool { normalizedURLString(relayURL) == normalizedURLString(defaultRelayURL) }
    var usesHostedAssistant: Bool { agentMode == .hosted }

    var statusText: String {
        switch state {
        case .notConfigured: "Relay needs attention"
        case .waitingForPushToken: "Preparing incoming calls…"
        case .connecting: "Connecting to Caller relay…"
        case .connected where agentMode == .hosted: "Built-in assistant ready"
        case .connected where agentPaired: "Agent paired and ready"
        case .connected: "iPhone ready to pair"
        case .failed(let message): message
        }
    }

    /// Records the relay's view of which agent serves this installation.
    func markAgentMode(_ mode: AgentMode) {
        agentMode = mode
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

    func isCurrentRelayGeneration(_ generation: Int) -> Bool {
        relayGeneration == generation
    }

    func relayConnectionSnapshot() -> RelayConnectionSnapshot {
        RelayConnectionSnapshot(
            relayURL: relayURL,
            installationID: installationID,
            installationSecret: installationSecret,
            pairingCode: pairingCode,
            pairingExpiresAt: pairingExpiresAt,
            agentPaired: agentPaired,
            state: state
        )
    }

    var pendingRelayTransition: PendingRelayTransition? {
        guard let value = credentials.string(for: Self.pendingRelayTransitionKey),
              let data = value.data(using: .utf8),
              let transition = try? JSONDecoder().decode(
                  PendingRelayTransition.self,
                  from: data
              ),
              transition.candidateRelayOrigin == recoveryOrigin else {
            return nil
        }
        return transition
    }

    @discardableResult
    func prepareRelayTransition(
        from snapshot: RelayConnectionSnapshot,
        to candidate: String
    ) -> Bool {
        guard let installationID = snapshot.installationID,
              let installationSecret = snapshot.installationSecret,
              let candidateURL = validatedRelayURL(for: candidate),
              let candidateOrigin = Self.recoveryOrigin(for: candidateURL) else {
            return true
        }
        let transition = PendingRelayTransition(
            previousRelayURL: snapshot.relayURL,
            previousInstallationID: installationID,
            previousInstallationSecret: installationSecret,
            candidateRelayOrigin: candidateOrigin
        )
        guard let data = try? JSONEncoder().encode(transition),
              let value = String(data: data, encoding: .utf8),
              credentials.set(value, for: Self.pendingRelayTransitionKey),
              credentials.string(for: Self.pendingRelayTransitionKey) == value else {
            state = .failed("Caller could not securely prepare the relay change")
            return false
        }
        return true
    }

    @discardableResult
    func clearPendingRelayTransition() -> Bool {
        _ = credentials.remove(Self.pendingRelayTransitionKey)
        guard credentials.string(for: Self.pendingRelayTransitionKey) == nil else {
            state = .failed("Caller could not finish securing the relay change")
            return false
        }
        return true
    }

    @discardableResult
    func updateRelayURL(_ candidate: String) -> Bool {
        guard let validatedURL = validatedRelayURL(for: candidate) else {
            state = .failed("Enter a valid HTTPS relay URL")
            return false
        }

        let updatedURL = normalizedURLString(validatedURL.absoluteString)
        let changed = updatedURL != normalizedURLString(relayURL)
        let previousCredentialURL = credentials.string(for: Self.relayURLCredentialKey)
        let previousInstallationCredential = credentials.string(
            for: Self.installationCredentialKey
        )
        guard persistRelayURL(updatedURL) else {
            state = .failed("Caller could not securely save its relay URL")
            return false
        }
        if changed, !clearInstallationCredentials() {
            restoreRelayURLCredential(previousCredentialURL)
            restoreInstallationCredentialValue(previousInstallationCredential)
            return false
        }
        relayURL = updatedURL
        defaults.set(relayURL, forKey: Self.relayURLKey)
        relayURLIsDurablyStored = true

        if changed {
            relayGeneration += 1
            pairingCode = nil
            pairingExpiresAt = nil
            agentPaired = false
            state = .waitingForPushToken
        }
        return true
    }

    @discardableResult
    func restoreRelayConnection(_ snapshot: RelayConnectionSnapshot) -> Bool {
        let normalizedRelayURL = normalizedURLString(snapshot.relayURL)
        guard let relayURL = validatedRelayURL(for: normalizedRelayURL),
              let relayOrigin = Self.recoveryOrigin(for: relayURL),
              persistRelayURL(normalizedRelayURL) else {
            relayURLIsDurablyStored = false
            state = .failed("Caller could not restore its previous relay connection")
            return false
        }

        if let installationID = snapshot.installationID,
           let installationSecret = snapshot.installationSecret {
            let storedCredential = StoredInstallationCredential(
                installationID: installationID,
                installationSecret: installationSecret,
                relayOrigin: relayOrigin
            )
            guard persistInstallationCredential(storedCredential) else {
                self.relayURL = normalizedRelayURL
                relayURLIsDurablyStored = true
                defaults.set(normalizedRelayURL, forKey: Self.relayURLKey)
                defaults.removeObject(forKey: Self.installationIDKey)
                pairingCode = nil
                pairingExpiresAt = nil
                agentPaired = false
                relayGeneration += 1
                state = .failed("Caller could not restore its previous secure credentials")
                return false
            }
            defaults.set(installationID, forKey: Self.installationIDKey)
        } else {
            defaults.removeObject(forKey: Self.installationIDKey)
        }

        self.relayURL = normalizedRelayURL
        relayURLIsDurablyStored = true
        defaults.set(normalizedRelayURL, forKey: Self.relayURLKey)
        pairingCode = snapshot.pairingCode
        pairingExpiresAt = snapshot.pairingExpiresAt
        agentPaired = snapshot.agentPaired
        relayGeneration += 1
        state = snapshot.state
        return true
    }

    @discardableResult
    func restoreDefaultRelayURL() -> Bool {
        updateRelayURL(defaultRelayURL)
    }

    @discardableResult
    func applyRegistration(_ registration: InstallationRegistration) -> Bool {
        guard let installationSecret = registration.installationSecret ?? self.installationSecret,
              let relayOrigin = recoveryOrigin,
              !registration.installationID.isEmpty,
              !installationSecret.isEmpty else {
            state = .failed("Caller relay did not return durable connection credentials")
            return false
        }
        let storedCredential = StoredInstallationCredential(
            installationID: registration.installationID,
            installationSecret: installationSecret,
            relayOrigin: relayOrigin
        )
        guard persistInstallationCredential(storedCredential) else {
            state = .failed("Caller could not save its secure connection credentials")
            return false
        }
        defaults.set(registration.installationID, forKey: Self.installationIDKey)
        _ = credentials.remove(Self.installationIDCredentialKey)
        _ = credentials.remove(Self.installationSecretKey)
        _ = credentials.remove(Self.legacyInstallationCredentialKey)
        pairingCode = registration.pairingCode
        pairingExpiresAt = registration.pairingExpiresAt
        agentPaired = registration.paired
        agentMode = AgentMode(rawValue: registration.agentMode) ?? .external
        hasPushToken = true
        state = .connected
        return true
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

    func markCleaningPreviousRelay() {
        state = .connecting
    }

    func markConnected() { state = .connected }
    func markFailed(_ message: String) { state = .failed(message) }

    @discardableResult
    func prepareForInstallationRecovery() -> Bool {
        guard clearInstallationCredentials() else { return false }
        pairingCode = nil
        pairingExpiresAt = nil
        agentPaired = false
        state = .connecting
        return true
    }

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
        if agentMode == .hosted { return .hostedAssistant }
        return agentPaired ? .paired : .readyToPair
    }

    @discardableResult
    private func clearInstallationCredentials() -> Bool {
        defaults.removeObject(forKey: Self.installationIDKey)
        _ = credentials.remove(Self.installationCredentialKey)
        _ = credentials.remove(Self.legacyInstallationCredentialKey)
        _ = credentials.remove(Self.installationIDCredentialKey)
        _ = credentials.remove(Self.installationSecretKey)
        guard credentials.string(for: Self.installationCredentialKey) == nil,
              credentials.string(for: Self.legacyInstallationCredentialKey) == nil,
              credentials.string(for: Self.installationIDCredentialKey) == nil,
              credentials.string(for: Self.installationSecretKey) == nil else {
            state = .failed("Caller could not clear its stale secure credentials")
            return false
        }
        return true
    }

    private static func normalizedURLString(_ value: String) -> String {
        value.trimmingCharacters(in: CharacterSet(charactersIn: "/").union(.whitespacesAndNewlines))
    }

    private func normalizedURLString(_ value: String) -> String {
        Self.normalizedURLString(value)
    }

    private var scopedDeviceIdentityCredentialKey: String? {
        guard let origin = recoveryOrigin else { return nil }
        let encodedOrigin = Data(origin.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return Self.scopedDeviceIdentityKeyPrefix + encodedOrigin
    }

    private var recoveryOrigin: String? {
        guard let url = validatedRelayURL else { return nil }
        return Self.recoveryOrigin(for: url)
    }

    private static func recoveryOrigin(for url: URL) -> String? {
        guard
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased() else {
            return nil
        }
        let defaultPort = scheme == "https" ? 443 : 80
        var components = URLComponents()
        components.scheme = scheme
        components.host = host.hasSuffix(".") ? String(host.dropLast()) : host
        if let port = url.port, port != defaultPort { components.port = port }
        return components.string
    }

    private var legacyDeviceIdentityIsRetired: Bool {
        defaults.bool(forKey: Self.legacyDeviceIdentityRetiredKey)
            || credentials.string(for: Self.legacyDeviceIdentityRetiredCredentialKey) == "true"
    }

    @discardableResult
    private func bindLegacyDeviceIdentityToCurrentOriginIfNeeded() -> Bool {
        guard !legacyDeviceIdentityIsRetired,
              credentials.string(for: Self.legacyDeviceIdentityOriginKey) == nil,
              let identity = credentials.string(for: Self.legacyDeviceIdentityKey),
              Self.isValidDeviceIdentity(identity),
              let recoveryOrigin else {
            return true
        }
        guard credentials.set(recoveryOrigin, for: Self.legacyDeviceIdentityOriginKey),
              credentials.string(for: Self.legacyDeviceIdentityOriginKey) == recoveryOrigin else {
            return false
        }
        return true
    }

    private var storedInstallationCredential: StoredInstallationCredential? {
        guard let value = credentials.string(for: Self.installationCredentialKey),
              let data = value.data(using: .utf8) else {
            return nil
        }
        guard let stored = try? JSONDecoder().decode(StoredInstallationCredential.self, from: data),
              stored.relayOrigin == recoveryOrigin else {
            return nil
        }
        return stored
    }

    private func persistInstallationCredential(_ credential: StoredInstallationCredential) -> Bool {
        guard let data = try? JSONEncoder().encode(credential),
              let value = String(data: data, encoding: .utf8),
              credentials.set(value, for: Self.installationCredentialKey),
              credentials.string(for: Self.installationCredentialKey) == value else {
            return false
        }
        return true
    }

    private func persistRelayURL(_ value: String) -> Bool {
        credentials.set(value, for: Self.relayURLCredentialKey)
            && credentials.string(for: Self.relayURLCredentialKey) == value
    }

    private func restoreRelayURLCredential(_ previousValue: String?) {
        if let previousValue {
            relayURLIsDurablyStored = credentials.set(
                previousValue,
                for: Self.relayURLCredentialKey
            ) && credentials.string(for: Self.relayURLCredentialKey) == previousValue
        } else {
            _ = credentials.remove(Self.relayURLCredentialKey)
            relayURLIsDurablyStored = credentials.string(for: Self.relayURLCredentialKey) == nil
        }
    }

    private func restoreInstallationCredentialValue(_ previousValue: String?) {
        guard let previousValue else { return }
        _ = credentials.set(previousValue, for: Self.installationCredentialKey)
    }

    private func isLocalDevelopmentURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "http" else { return false }
        return ["localhost", "127.0.0.1"].contains(url.host?.lowercased() ?? "")
    }

    private static func isLegacyRelayURL(_ value: String) -> Bool {
        let normalized = value.trimmingCharacters(in: CharacterSet(charactersIn: "/").union(.whitespacesAndNewlines))
        return [legacyPlaceholderURL, legacyMacRelayURL].contains(normalized)
    }

    private static func isValidDeviceIdentity(_ value: String) -> Bool {
        value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }
}

private struct StoredInstallationCredential: Codable, Equatable {
    let installationID: String
    let installationSecret: String
    let relayOrigin: String
}

struct InstallationRegistration: Decodable {
    let installationID: String
    let installationSecret: String?
    let paired: Bool
    let pairingCode: String?
    let pairingExpiresAt: Date?
    let agentMode: String

    enum CodingKeys: String, CodingKey {
        case installationID = "installation_id"
        case installationSecret = "installation_secret"
        case paired
        case pairingCode = "pairing_code"
        case pairingExpiresAt = "pairing_expires_at"
        case agentMode = "agent_mode"
    }

    init(
        installationID: String,
        installationSecret: String?,
        paired: Bool,
        pairingCode: String?,
        pairingExpiresAt: Date?,
        agentMode: String = "external"
    ) {
        self.installationID = installationID
        self.installationSecret = installationSecret
        self.paired = paired
        self.pairingCode = pairingCode
        self.pairingExpiresAt = pairingExpiresAt
        self.agentMode = agentMode
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        installationID = try container.decode(String.self, forKey: .installationID)
        installationSecret = try container.decodeIfPresent(String.self, forKey: .installationSecret)
        paired = try container.decodeIfPresent(Bool.self, forKey: .paired) ?? false
        pairingCode = try container.decodeIfPresent(String.self, forKey: .pairingCode)
        pairingExpiresAt = try container.decodeIfPresent(Date.self, forKey: .pairingExpiresAt)
        // Relays predating hosted mode omit the field; treat them as external-agent only.
        agentMode = try container.decodeIfPresent(String.self, forKey: .agentMode) ?? "external"
    }
}
