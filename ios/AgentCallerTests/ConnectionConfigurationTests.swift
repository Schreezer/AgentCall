import XCTest
@testable import AgentCaller

private final class TestCredentialStore: CredentialStoring {
    var values: [String: String] = [:]
    func string(for key: String) -> String? { values[key] }
    func set(_ value: String, for key: String) -> Bool { values[key] = value; return true }
    func remove(_ key: String) -> Bool { values.removeValue(forKey: key) != nil }
}

private final class RegistrationRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var methods: [String] = []
    private var expectation: XCTestExpectation?

    func reset(expectation: XCTestExpectation) {
        lock.lock()
        methods = []
        self.expectation = expectation
        lock.unlock()
    }

    func record(_ method: String) {
        lock.lock()
        methods.append(method)
        let shouldFulfill = methods.count == 2
        let expectation = self.expectation
        lock.unlock()
        if shouldFulfill { expectation?.fulfill() }
    }

    func snapshot() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return methods
    }
}

private final class RegistrationURLProtocol: URLProtocol {
    static let recorder = RegistrationRequestRecorder()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        Self.recorder.record(method)
        var payload: [String: Any] = [
            "installation_id": "installation-1",
            "paired": true,
            "pairing_code": NSNull(),
            "pairing_expires_at": NSNull(),
        ]
        if method == "POST" { payload["installation_secret"] = "private-secret" }
        let body = try! JSONSerialization.data(withJSONObject: payload)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
final class ConnectionConfigurationTests: XCTestCase {
    func testAcceptsHTTPSRelayURL() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let subject = ConnectionConfiguration(defaults: suite, credentials: TestCredentialStore())
        XCTAssertTrue(subject.updateRelayURL("https://relay.caller.example"))
        XCTAssertEqual(subject.validatedRelayURL?.host, "relay.caller.example")
    }

    func testRejectsInsecureRemoteURL() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let subject = ConnectionConfiguration(defaults: suite, credentials: TestCredentialStore())
        XCTAssertFalse(subject.updateRelayURL("http://caller.example"))
    }

    func testAcceptsLocalHTTPForDevelopment() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let subject = ConnectionConfiguration(defaults: suite, credentials: TestCredentialStore())
        XCTAssertTrue(subject.updateRelayURL("http://127.0.0.1:8788"))
    }

    func testManagedRelayIsPreconfiguredAndPersistedOnFirstLaunch() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: TestCredentialStore(),
            defaultRelayURL: "https://managed.caller.example"
        )
        XCTAssertEqual(subject.relayURL, "https://managed.caller.example")
        XCTAssertEqual(suite.string(forKey: "agentCaller.relayURL"), "https://managed.caller.example")
        XCTAssertTrue(subject.isUsingDefaultRelay)
        XCTAssertEqual(subject.state, .waitingForPushToken)
    }

    func testAgentInstructionsStayLockedUntilDeviceRegistrationCompletes() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let subject = ConnectionConfiguration(defaults: suite, credentials: TestCredentialStore())
        XCTAssertFalse(subject.isReadyForAgentSetup)

        subject.markPushTokenAvailable()
        XCTAssertFalse(subject.isReadyForAgentSetup)

        subject.applyRegistration(InstallationRegistration(
            installationID: "installation-1",
            installationSecret: "private-secret",
            paired: false,
            pairingCode: "HERM-3S26",
            pairingExpiresAt: Date().addingTimeInterval(60)
        ))
        XCTAssertTrue(subject.isReadyForAgentSetup)
        XCTAssertTrue(subject.hasUsablePairingCode())
    }

    func testRegistrationStoresInstallationSecretOutsideUserDefaults() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let subject = ConnectionConfiguration(defaults: suite, credentials: credentials)
        subject.applyRegistration(InstallationRegistration(
            installationID: "installation-1",
            installationSecret: "private-secret",
            paired: false,
            pairingCode: "HERM-3S26",
            pairingExpiresAt: Date()
        ))
        XCTAssertEqual(subject.installationID, "installation-1")
        XCTAssertEqual(subject.installationSecret, "private-secret")
        XCTAssertNil(suite.string(forKey: "installation-secret"))
        XCTAssertEqual(subject.pairingCode, "HERM-3S26")
    }

    func testDeviceIdentityIsStableAndStoredOnlyInKeychain() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let subject = ConnectionConfiguration(defaults: suite, credentials: credentials)

        let first = subject.deviceIdentity
        let second = subject.deviceIdentity

        XCTAssertEqual(first, second)
        XCTAssertNotNil(first.range(of: "^[0-9a-f]{64}$", options: .regularExpression))
        XCTAssertEqual(credentials.values["device-identity"], first)
        XCTAssertNil(suite.string(forKey: "device-identity"))
    }

    func testPushTokenCallbacksSerializeInitialRegistrationBeforeUpdatingDevice() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: TestCredentialStore(),
            defaultRelayURL: "https://relay.test"
        )
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [RegistrationURLProtocol.self]
        let urlSession = URLSession(configuration: sessionConfiguration)
        let manager = PushManager(callCoordinator: CallCoordinator(), urlSession: urlSession)
        manager.configuration = subject
        let completed = expectation(description: "serialized registration and update")
        RegistrationURLProtocol.recorder.reset(expectation: completed)

        manager.didReceiveVoIPToken(Data(repeating: 1, count: 32))
        manager.didRegisterAlertToken(Data(repeating: 2, count: 32))

        await fulfillment(of: [completed], timeout: 2)
        XCTAssertEqual(RegistrationURLProtocol.recorder.snapshot(), ["POST", "PUT"])
        XCTAssertEqual(subject.installationID, "installation-1")
        XCTAssertEqual(subject.installationSecret, "private-secret")
        XCTAssertTrue(subject.agentPaired)
    }

    func testChangingRelayClearsInstallationAndPairingCredentials() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://managed.caller.example"
        )
        subject.applyRegistration(InstallationRegistration(
            installationID: "installation-1",
            installationSecret: "private-secret",
            paired: true,
            pairingCode: nil,
            pairingExpiresAt: nil
        ))

        XCTAssertTrue(subject.updateRelayURL("https://self-hosted.example"))
        XCTAssertNil(subject.installationID)
        XCTAssertNil(subject.installationSecret)
        XCTAssertNil(subject.pairingCode)
        XCTAssertFalse(subject.agentPaired)
        XCTAssertEqual(subject.state, .waitingForPushToken)
    }

    func testLegacyPlaceholderMigratesToManagedRelayWithoutDeletingConnection() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        suite.set("https://push.caller.example", forKey: "agentCaller.relayURL")
        suite.set("legacy-installation", forKey: "agentCaller.installationID")
        credentials.values["installation-secret"] = "legacy-secret"
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://managed.caller.example"
        )
        XCTAssertEqual(subject.relayURL, "https://managed.caller.example")
        XCTAssertEqual(subject.installationID, "legacy-installation")
        XCTAssertEqual(subject.installationSecret, "legacy-secret")
    }

    func testLegacyMacRelayMigratesToManagedRelayWithoutDeletingConnection() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        suite.set("https://macbook-pro-4.tail38a470.ts.net/", forKey: "agentCaller.relayURL")
        suite.set("legacy-installation", forKey: "agentCaller.installationID")
        credentials.values["installation-secret"] = "legacy-secret"
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://managed.caller.example"
        )
        XCTAssertEqual(subject.relayURL, "https://managed.caller.example")
        XCTAssertEqual(subject.installationID, "legacy-installation")
        XCTAssertEqual(subject.installationSecret, "legacy-secret")
    }

    func testRestoresInstallationIdentityAndRelayFromKeychainAfterDefaultsReset() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        credentials.values["relay-url"] = "https://managed.caller.example"
        credentials.values["installation-id"] = "installation-1"
        credentials.values["installation-secret"] = "private-secret"

        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://other-default.example"
        )

        XCTAssertEqual(subject.relayURL, "https://managed.caller.example")
        XCTAssertEqual(subject.installationID, "installation-1")
        XCTAssertEqual(subject.installationSecret, "private-secret")
        XCTAssertEqual(suite.string(forKey: "agentCaller.installationID"), "installation-1")
        XCTAssertEqual(suite.string(forKey: "agentCaller.relayURL"), "https://managed.caller.example")
    }

    func testAgentInstructionsUseManagedRelayAndNeverRequestAppleCredentials() {
        let instructions = AgentSetupInstructions.text(
            relayURL: "https://push.caller.example",
            pairingCode: "HERM-3S26"
        )
        XCTAssertTrue(instructions.contains("CALLER_PAIRING_CODE=HERM-3S26"))
        XCTAssertTrue(instructions.contains("/v1/pairings/claim"))
        XCTAssertTrue(instructions.contains("CALLER_AGENT_TOKEN"))
        XCTAssertTrue(instructions.contains("Idempotency-Key"))
        XCTAssertTrue(instructions.contains("Never ask me for those"))
        XCTAssertFalse(instructions.contains("APNS_TEAM_ID="))
        XCTAssertFalse(instructions.contains("APNS_KEY_ID="))
        XCTAssertFalse(instructions.contains("APNS_PRIVATE_KEY_PATH="))
        XCTAssertFalse(instructions.contains("/Users/"))
    }

    func testHomeStateShowsOnlyTheNextRelevantStep() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let subject = ConnectionConfiguration(defaults: suite, credentials: TestCredentialStore())
        XCTAssertEqual(subject.homeState(), .preparing)

        subject.applyRegistration(InstallationRegistration(
            installationID: "installation-1",
            installationSecret: "private-secret",
            paired: false,
            pairingCode: nil,
            pairingExpiresAt: nil
        ))
        XCTAssertEqual(subject.homeState(), .readyToPair)

        subject.applyRegistration(InstallationRegistration(
            installationID: "installation-1",
            installationSecret: nil,
            paired: false,
            pairingCode: "HERM-3S26",
            pairingExpiresAt: Date().addingTimeInterval(60)
        ))
        XCTAssertEqual(subject.homeState(), .waitingForPairing)

        subject.applyRegistration(InstallationRegistration(
            installationID: "installation-1",
            installationSecret: nil,
            paired: true,
            pairingCode: nil,
            pairingExpiresAt: nil
        ))
        XCTAssertEqual(subject.homeState(), .paired)
    }

    func testHomeStateSurfacesConnectionFailure() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let subject = ConnectionConfiguration(defaults: suite, credentials: TestCredentialStore())
        subject.markFailed("Relay unavailable")
        XCTAssertEqual(subject.homeState(), .needsAttention("Relay unavailable"))
    }
}
