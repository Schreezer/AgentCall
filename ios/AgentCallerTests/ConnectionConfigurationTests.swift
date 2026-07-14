import XCTest
@testable import AgentCaller

private final class TestCredentialStore: CredentialStoring {
    var values: [String: String] = [:]
    func string(for key: String) -> String? { values[key] }
    func set(_ value: String, for key: String) -> Bool { values[key] = value; return true }
    func remove(_ key: String) -> Bool { values.removeValue(forKey: key) != nil }
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

    func testLegacyPlaceholderMigratesToManagedRelay() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        suite.set("https://push.caller.example", forKey: "agentCaller.relayURL")
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: TestCredentialStore(),
            defaultRelayURL: "https://managed.caller.example"
        )
        XCTAssertEqual(subject.relayURL, "https://managed.caller.example")
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
