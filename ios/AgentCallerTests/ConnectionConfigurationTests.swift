import XCTest
@testable import AgentCaller

private final class TestCredentialStore: CredentialStoring {
    var values: [String: String] = [:]
    var acceptsWrites = true
    var rejectedWriteKeys: Set<String> = []
    var rejectedWriteValuesByKey: [String: Set<String>] = [:]
    var rejectedRemovalKeys: Set<String> = []
    func string(for key: String) -> String? { values[key] }
    func set(_ value: String, for key: String) -> Bool {
        guard acceptsWrites,
              !rejectedWriteKeys.contains(key),
              !rejectedWriteValuesByKey[key, default: []].contains(value) else {
            return false
        }
        values[key] = value
        return true
    }
    func remove(_ key: String) -> Bool {
        guard !rejectedRemovalKeys.contains(key) else { return false }
        return values.removeValue(forKey: key) != nil
    }
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

private final class RecoveryRegistrationRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [(method: String, identity: String?)] = []
    private var expectation: XCTestExpectation?

    func reset(expectation: XCTestExpectation) {
        lock.lock()
        requests = []
        self.expectation = expectation
        lock.unlock()
    }

    func record(_ request: URLRequest) -> Int {
        let body = requestBody(request).flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }
        lock.lock()
        requests.append((request.httpMethod ?? "GET", body?["device_identity"] as? String))
        let count = requests.count
        let expectation = self.expectation
        lock.unlock()
        if count == 3 { expectation?.fulfill() }
        return count
    }

    func snapshot() -> [(method: String, identity: String?)] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    private func requestBody(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private final class RecoveryRegistrationURLProtocol: URLProtocol {
    static let recorder = RecoveryRegistrationRecorder()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let attempt = Self.recorder.record(request)
        let status = attempt == 1 ? 401 : 200
        var payload: [String: Any] = [:]
        if status == 200 {
            payload = [
                "installation_id": "installation-1",
                "paired": true,
                "pairing_code": NSNull(),
                "pairing_expires_at": NSNull(),
            ]
            if request.httpMethod == "POST" {
                payload["installation_secret"] = "recovered-secret"
            }
        }
        let body = try! JSONSerialization.data(withJSONObject: payload)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class DelayedRegistrationURLProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var pending: DelayedRegistrationURLProtocol?
    nonisolated(unsafe) private static var startedExpectation: XCTestExpectation?
    nonisolated(unsafe) private static var responseData = makeResponseData()

    static func reset(
        started: XCTestExpectation,
        payload: [String: Any] = [
            "installation_id": "stale-installation",
            "installation_secret": "stale-secret",
            "paired": true,
            "pairing_code": NSNull(),
            "pairing_expires_at": NSNull(),
        ]
    ) {
        lock.lock()
        pending = nil
        startedExpectation = started
        responseData = try! JSONSerialization.data(withJSONObject: payload)
        lock.unlock()
    }

    static func complete() {
        lock.lock()
        let request = pending
        pending = nil
        let body = responseData
        lock.unlock()
        guard let request else { return }
        let response = HTTPURLResponse(
            url: request.request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        request.client?.urlProtocol(request, didReceive: response, cacheStoragePolicy: .notAllowed)
        request.client?.urlProtocol(request, didLoad: body)
        request.client?.urlProtocolDidFinishLoading(request)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.pending = self
        let expectation = Self.startedExpectation
        Self.lock.unlock()
        expectation?.fulfill()
    }

    override func stopLoading() {}

    private static func makeResponseData() -> Data {
        try! JSONSerialization.data(withJSONObject: [
            "installation_id": "stale-installation",
            "installation_secret": "stale-secret",
            "paired": true,
            "pairing_code": NSNull(),
            "pairing_expires_at": NSNull(),
        ])
    }
}

private final class RelayChangeRaceRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [String] = []
    private var initialStarted: XCTestExpectation?
    private var initialCancelled: XCTestExpectation?
    private var deleteStarted: XCTestExpectation?
    private var finalRegistration: XCTestExpectation?

    func reset(
        initialStarted: XCTestExpectation,
        initialCancelled: XCTestExpectation,
        deleteStarted: XCTestExpectation,
        finalRegistration: XCTestExpectation
    ) {
        lock.lock()
        requests = []
        self.initialStarted = initialStarted
        self.initialCancelled = initialCancelled
        self.deleteStarted = deleteStarted
        self.finalRegistration = finalRegistration
        lock.unlock()
    }

    func record(_ request: URLRequest) {
        let method = request.httpMethod ?? "GET"
        let host = request.url?.host ?? "missing-host"
        lock.lock()
        requests.append("\(method) \(host)")
        let initialStarted = self.initialStarted
        let deleteStarted = self.deleteStarted
        let finalRegistration = self.finalRegistration
        lock.unlock()
        if method == "PUT" { initialStarted?.fulfill() }
        if method == "DELETE" { deleteStarted?.fulfill() }
        if method == "POST" { finalRegistration?.fulfill() }
    }

    func recordInitialCancellation() {
        lock.lock()
        let expectation = initialCancelled
        lock.unlock()
        expectation?.fulfill()
    }

    func snapshot() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }
}

private final class RelayChangeRaceURLProtocol: URLProtocol {
    static let recorder = RelayChangeRaceRecorder()
    private static let lock = NSLock()
    nonisolated(unsafe) private static var pendingDelete: RelayChangeRaceURLProtocol?

    static func reset(
        initialStarted: XCTestExpectation,
        initialCancelled: XCTestExpectation,
        deleteStarted: XCTestExpectation,
        finalRegistration: XCTestExpectation
    ) {
        lock.lock()
        pendingDelete = nil
        lock.unlock()
        recorder.reset(
            initialStarted: initialStarted,
            initialCancelled: initialCancelled,
            deleteStarted: deleteStarted,
            finalRegistration: finalRegistration
        )
    }

    static func completeDelete() {
        lock.lock()
        let request = pendingDelete
        pendingDelete = nil
        lock.unlock()
        guard let request else { return }
        request.finish(status: 204, payload: [:])
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.recorder.record(request)
        switch request.httpMethod {
        case "PUT":
            break
        case "DELETE":
            Self.lock.lock()
            Self.pendingDelete = self
            Self.lock.unlock()
        default:
            finish(status: 200, payload: [
                "installation_id": "relay-b-installation",
                "installation_secret": "relay-b-secret",
                "paired": false,
                "pairing_code": NSNull(),
                "pairing_expires_at": NSNull(),
            ])
        }
    }

    override func stopLoading() {
        if request.httpMethod == "PUT" {
            Self.recorder.recordInitialCancellation()
        }
    }

    private func finish(status: Int, payload: [String: Any]) {
        let body = try! JSONSerialization.data(withJSONObject: payload)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}

private final class RequestCountRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func reset() {
        lock.lock()
        count = 0
        lock.unlock()
    }

    func record() {
        lock.lock()
        count += 1
        lock.unlock()
    }

    func snapshot() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

private final class UnexpectedRelayDeleteURLProtocol: URLProtocol {
    static let recorder = RequestCountRecorder()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.recorder.record()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 204,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class FailingRelayDeleteURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 500,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class PendingTransitionRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [String] = []
    private var completed: XCTestExpectation?

    func reset(completed: XCTestExpectation) {
        lock.lock()
        requests = []
        self.completed = completed
        lock.unlock()
    }

    func record(_ request: URLRequest) {
        let entry = "\(request.httpMethod ?? "GET") \(request.url?.host ?? "missing-host")"
        lock.lock()
        requests.append(entry)
        let shouldComplete = requests.count == 2
        let completed = self.completed
        lock.unlock()
        if shouldComplete { completed?.fulfill() }
    }

    func snapshot() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }
}

private final class PendingTransitionResumeURLProtocol: URLProtocol {
    static let recorder = PendingTransitionRecorder()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.recorder.record(request)
        let isDelete = request.httpMethod == "DELETE"
        let status = isDelete ? 404 : 200
        let payload: [String: Any] = isDelete ? [:] : [
            "installation_id": "relay-b-installation",
            "installation_secret": "relay-b-secret",
            "paired": false,
            "pairing_code": NSNull(),
            "pairing_expires_at": NSNull(),
        ]
        let body = try! JSONSerialization.data(withJSONObject: payload)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
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

    func testRegistrationFailsClosedWhenBundledCredentialWriteFails() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let subject = ConnectionConfiguration(defaults: suite, credentials: credentials)
        credentials.rejectedWriteKeys.insert("installation-credential-v3")

        XCTAssertFalse(subject.applyRegistration(InstallationRegistration(
            installationID: "installation-1",
            installationSecret: "private-secret",
            paired: true,
            pairingCode: nil,
            pairingExpiresAt: nil
        )))
        XCTAssertEqual(
            subject.state,
            .failed("Caller could not save its secure connection credentials")
        )
        XCTAssertFalse(subject.agentPaired)
        XCTAssertNil(subject.installationID)
        XCTAssertNil(subject.installationSecret)
    }

    func testRecoveryStopsWhenStaleCredentialDeletionFails() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let subject = ConnectionConfiguration(defaults: suite, credentials: credentials)
        XCTAssertTrue(subject.applyRegistration(InstallationRegistration(
            installationID: "installation-1",
            installationSecret: "private-secret",
            paired: true,
            pairingCode: nil,
            pairingExpiresAt: nil
        )))
        credentials.rejectedRemovalKeys.insert("installation-credential-v3")

        XCTAssertFalse(subject.prepareForInstallationRecovery())
        XCTAssertEqual(
            subject.state,
            .failed("Caller could not clear its stale secure credentials")
        )
        XCTAssertEqual(subject.installationID, "installation-1")
        XCTAssertEqual(subject.installationSecret, "private-secret")
    }

    func testDeviceIdentityIsStableAndScopedToRelayOrigin() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let subject = ConnectionConfiguration(defaults: suite, credentials: credentials)

        let first = subject.deviceIdentityForRegistration(allowLegacyRecovery: false)
        let second = subject.deviceIdentityForRegistration(allowLegacyRecovery: false)

        XCTAssertEqual(first, second)
        XCTAssertNotNil(first?.value.range(of: "^[0-9a-f]{64}$", options: .regularExpression))
        XCTAssertEqual(credentials.values.values.filter { $0 == first?.value }.count, 1)
        XCTAssertNil(suite.string(forKey: "device-identity"))

        XCTAssertTrue(subject.updateRelayURL("https://other-relay.example/path"))
        let otherOrigin = subject.deviceIdentityForRegistration(allowLegacyRecovery: false)
        XCTAssertNotEqual(otherOrigin?.value, first?.value)

        XCTAssertTrue(subject.updateRelayURL("https://other-relay.example/another-path"))
        XCTAssertEqual(
            subject.deviceIdentityForRegistration(allowLegacyRecovery: false)?.value,
            otherOrigin?.value
        )
    }

    func testDeviceIdentityFailsClosedWhenKeychainRejectsWrite() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let subject = ConnectionConfiguration(defaults: suite, credentials: credentials)
        credentials.acceptsWrites = false

        let manager = PushManager(callCoordinator: CallCoordinator())
        manager.configuration = subject
        manager.didReceiveVoIPToken(Data(repeating: 1, count: 32))

        XCTAssertEqual(
            subject.state,
            .failed("Caller could not save its secure connection identity")
        )
        XCTAssertNil(credentials.values.values.first { $0.count == 64 })
    }

    func testLegacyIdentityCannotCrossRelayOrigins() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let legacyIdentity = String(repeating: "ab", count: 32)
        credentials.values["device-identity"] = legacyIdentity
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://original-relay.example"
        )

        XCTAssertEqual(
            subject.deviceIdentityForRegistration(allowLegacyRecovery: true)?.value,
            legacyIdentity
        )
        XCTAssertTrue(subject.updateRelayURL("https://different-relay.example"))
        let differentRelayIdentity = subject.deviceIdentityForRegistration(
            allowLegacyRecovery: true
        )

        XCTAssertNotEqual(differentRelayIdentity?.value, legacyIdentity)
        XCTAssertEqual(differentRelayIdentity?.usesLegacyRecoveryIdentity, false)
    }

    func testUnboundLegacyIdentityFailsClosedWhenOriginBindingCannotPersist() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        credentials.values["device-identity"] = String(repeating: "ab", count: 32)
        credentials.rejectedWriteKeys.insert("device-identity-legacy-origin")
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://relay.test"
        )

        XCTAssertNil(subject.deviceIdentityForRegistration(allowLegacyRecovery: true))
        XCTAssertNil(credentials.values["device-identity-legacy-origin"])
    }

    func testLegacyRetirementTombstoneSurvivesDeletionFailureAndDefaultsReset() {
        let firstSuite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let legacyIdentity = String(repeating: "ab", count: 32)
        credentials.values["device-identity"] = legacyIdentity
        let first = ConnectionConfiguration(
            defaults: firstSuite,
            credentials: credentials,
            defaultRelayURL: "https://relay.test"
        )
        let scoped = first.deviceIdentityForRegistration(allowLegacyRecovery: false)!
        credentials.rejectedRemovalKeys.insert("device-identity")

        XCTAssertFalse(first.markDeviceIdentityRegistered(scoped))
        XCTAssertEqual(credentials.values["device-identity-legacy-retired"], "true")
        XCTAssertEqual(credentials.values["device-identity"], legacyIdentity)

        let second = ConnectionConfiguration(
            defaults: UserDefaults(suiteName: UUID().uuidString)!,
            credentials: credentials,
            defaultRelayURL: "https://relay.test"
        )
        let afterReset = second.deviceIdentityForRegistration(allowLegacyRecovery: true)
        XCTAssertEqual(afterReset?.value, scoped.value)
        XCTAssertEqual(afterReset?.usesLegacyRecoveryIdentity, false)
    }

    func testUnauthorizedUpdateRecoversThenRotatesLegacyIdentity() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let legacyIdentity = String(repeating: "ab", count: 32)
        credentials.values["device-identity"] = legacyIdentity
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://relay.test"
        )
        subject.applyRegistration(InstallationRegistration(
            installationID: "stale-installation",
            installationSecret: "stale-secret",
            paired: true,
            pairingCode: nil,
            pairingExpiresAt: nil
        ))
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [RecoveryRegistrationURLProtocol.self]
        let manager = PushManager(
            callCoordinator: CallCoordinator(),
            urlSession: URLSession(configuration: sessionConfiguration)
        )
        manager.configuration = subject
        let completed = expectation(description: "recover and rotate legacy identity")
        RecoveryRegistrationURLProtocol.recorder.reset(expectation: completed)

        manager.didReceiveVoIPToken(Data(repeating: 1, count: 32))

        await fulfillment(of: [completed], timeout: 2)
        for _ in 0..<1_000 where credentials.values["device-identity"] != nil {
            await Task.yield()
        }
        let requests = RecoveryRegistrationURLProtocol.recorder.snapshot()
        XCTAssertEqual(requests.map(\.method), ["PUT", "POST", "PUT"])
        XCTAssertNotEqual(requests[0].identity, legacyIdentity)
        XCTAssertEqual(requests[1].identity, legacyIdentity)
        XCTAssertEqual(requests[2].identity, requests[0].identity)
        XCTAssertEqual(subject.installationID, "installation-1")
        XCTAssertEqual(subject.installationSecret, "recovered-secret")
        XCTAssertTrue(subject.agentPaired)
        XCTAssertNil(credentials.values["device-identity"])
    }

    func testStaleRegistrationResponseCannotCrossRelayGeneration() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: TestCredentialStore(),
            defaultRelayURL: "https://relay-a.test"
        )
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [DelayedRegistrationURLProtocol.self]
        let manager = PushManager(
            callCoordinator: CallCoordinator(),
            urlSession: URLSession(configuration: sessionConfiguration)
        )
        manager.configuration = subject
        let started = expectation(description: "registration request started")
        DelayedRegistrationURLProtocol.reset(started: started)

        manager.didReceiveVoIPToken(Data(repeating: 1, count: 32))
        await fulfillment(of: [started], timeout: 2)
        XCTAssertTrue(subject.updateRelayURL("https://relay-b.test"))
        XCTAssertTrue(subject.updateRelayURL("https://relay-a.test"))
        DelayedRegistrationURLProtocol.complete()
        for _ in 0..<1_000 { await Task.yield() }

        XCTAssertNil(subject.installationID)
        XCTAssertNil(subject.installationSecret)
        XCTAssertFalse(subject.agentPaired)
        XCTAssertEqual(subject.relayGeneration, 2)
    }

    func testStalePairingCodeResponseCannotCrossRelayGeneration() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: TestCredentialStore(),
            defaultRelayURL: "https://relay-a.test"
        )
        XCTAssertTrue(subject.applyRegistration(InstallationRegistration(
            installationID: "relay-a-installation",
            installationSecret: "relay-a-secret",
            paired: false,
            pairingCode: nil,
            pairingExpiresAt: nil
        )))
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [DelayedRegistrationURLProtocol.self]
        let manager = PushManager(
            callCoordinator: CallCoordinator(),
            urlSession: URLSession(configuration: sessionConfiguration)
        )
        manager.configuration = subject
        let started = expectation(description: "pairing-code request started")
        DelayedRegistrationURLProtocol.reset(started: started, payload: [
            "installation_id": "relay-a-installation",
            "paired": true,
            "pairing_code": "STALE-A",
            "pairing_expires_at": NSNull(),
        ])

        manager.createPairingCode()
        await fulfillment(of: [started], timeout: 2)
        XCTAssertTrue(subject.updateRelayURL("https://relay-b.test"))
        XCTAssertTrue(subject.updateRelayURL("https://relay-a.test"))
        DelayedRegistrationURLProtocol.complete()
        for _ in 0..<1_000 { await Task.yield() }

        XCTAssertNil(subject.installationID)
        XCTAssertNil(subject.installationSecret)
        XCTAssertNil(subject.pairingCode)
        XCTAssertFalse(subject.agentPaired)
    }

    func testStalePairingStatusResponseCannotCrossRelayGeneration() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: TestCredentialStore(),
            defaultRelayURL: "https://relay-a.test"
        )
        XCTAssertTrue(subject.applyRegistration(InstallationRegistration(
            installationID: "relay-a-installation",
            installationSecret: "relay-a-secret",
            paired: false,
            pairingCode: nil,
            pairingExpiresAt: nil
        )))
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [DelayedRegistrationURLProtocol.self]
        let manager = PushManager(
            callCoordinator: CallCoordinator(),
            urlSession: URLSession(configuration: sessionConfiguration)
        )
        manager.configuration = subject
        let started = expectation(description: "pairing-status request started")
        DelayedRegistrationURLProtocol.reset(started: started, payload: [
            "installation_id": "relay-a-installation",
            "paired": true,
            "pairing_code": NSNull(),
            "pairing_expires_at": NSNull(),
        ])

        manager.refreshPairingStatus()
        await fulfillment(of: [started], timeout: 2)
        XCTAssertTrue(subject.updateRelayURL("https://relay-b.test"))
        XCTAssertTrue(subject.updateRelayURL("https://relay-a.test"))
        DelayedRegistrationURLProtocol.complete()
        for _ in 0..<1_000 { await Task.yield() }

        XCTAssertNil(subject.installationID)
        XCTAssertNil(subject.installationSecret)
        XCTAssertFalse(subject.agentPaired)
    }

    func testTokenCallbackDuringRelayCancellationRestartsOnlyOnNewRelay() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: TestCredentialStore(),
            defaultRelayURL: "https://relay-a.test"
        )
        XCTAssertTrue(subject.applyRegistration(InstallationRegistration(
            installationID: "relay-a-installation",
            installationSecret: "relay-a-secret",
            paired: true,
            pairingCode: nil,
            pairingExpiresAt: nil
        )))
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [RelayChangeRaceURLProtocol.self]
        let manager = PushManager(
            callCoordinator: CallCoordinator(),
            urlSession: URLSession(configuration: sessionConfiguration)
        )
        manager.configuration = subject
        let initialStarted = expectation(description: "old-relay registration started")
        let initialCancelled = expectation(description: "old-relay registration cancelled")
        let deleteStarted = expectation(description: "old relay disconnect started")
        let finalRegistration = expectation(description: "new-relay registration completed")
        RelayChangeRaceURLProtocol.reset(
            initialStarted: initialStarted,
            initialCancelled: initialCancelled,
            deleteStarted: deleteStarted,
            finalRegistration: finalRegistration
        )

        manager.didReceiveVoIPToken(Data(repeating: 1, count: 32))
        await fulfillment(of: [initialStarted], timeout: 2)
        let relayChange = Task {
            await manager.changeRelay(to: "https://relay-b.test")
        }
        await fulfillment(of: [initialCancelled, deleteStarted], timeout: 2)
        manager.didRegisterAlertToken(Data(repeating: 2, count: 32))
        RelayChangeRaceURLProtocol.completeDelete()

        let relayChanged = await relayChange.value
        XCTAssertTrue(relayChanged)
        await fulfillment(of: [finalRegistration], timeout: 2)
        for _ in 0..<1_000 where subject.installationID != "relay-b-installation" {
            await Task.yield()
        }

        XCTAssertEqual(
            RelayChangeRaceURLProtocol.recorder.snapshot(),
            ["PUT relay-a.test", "DELETE relay-a.test", "POST relay-b.test"]
        )
        XCTAssertEqual(subject.installationID, "relay-b-installation")
        XCTAssertEqual(subject.installationSecret, "relay-b-secret")
        XCTAssertEqual(subject.validatedRelayURL?.host, "relay-b.test")
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

    func testRelayURLWriteFailureDoesNotMutateRelayOrBoundCredentials() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://relay-a.test"
        )
        XCTAssertTrue(subject.applyRegistration(InstallationRegistration(
            installationID: "relay-a-installation",
            installationSecret: "relay-a-secret",
            paired: true,
            pairingCode: nil,
            pairingExpiresAt: nil
        )))
        credentials.rejectedWriteKeys.insert("relay-url")

        XCTAssertFalse(subject.updateRelayURL("https://relay-b.test"))

        XCTAssertEqual(subject.validatedRelayURL?.host, "relay-a.test")
        XCTAssertEqual(subject.installationID, "relay-a-installation")
        XCTAssertEqual(subject.installationSecret, "relay-a-secret")
        XCTAssertEqual(credentials.values["relay-url"], "https://relay-a.test")
        XCTAssertEqual(subject.state, .failed("Caller could not securely save its relay URL"))
    }

    func testManagerDoesNotDeleteOldRelayWhenNewRelayURLCannotPersist() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://relay-a.test"
        )
        XCTAssertTrue(subject.applyRegistration(InstallationRegistration(
            installationID: "relay-a-installation",
            installationSecret: "relay-a-secret",
            paired: true,
            pairingCode: nil,
            pairingExpiresAt: nil
        )))
        credentials.rejectedWriteKeys.insert("relay-url")
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [UnexpectedRelayDeleteURLProtocol.self]
        UnexpectedRelayDeleteURLProtocol.recorder.reset()
        let manager = PushManager(
            callCoordinator: CallCoordinator(),
            urlSession: URLSession(configuration: sessionConfiguration)
        )
        manager.configuration = subject

        let changedRelay = await manager.changeRelay(to: "https://relay-b.test")
        XCTAssertFalse(changedRelay)

        XCTAssertEqual(UnexpectedRelayDeleteURLProtocol.recorder.snapshot(), 0)
        XCTAssertEqual(subject.validatedRelayURL?.host, "relay-a.test")
        XCTAssertEqual(subject.installationID, "relay-a-installation")
    }

    func testManagerDoesNotDeleteOldRelayWhenCredentialClearFails() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://relay-a.test"
        )
        XCTAssertTrue(subject.applyRegistration(InstallationRegistration(
            installationID: "relay-a-installation",
            installationSecret: "relay-a-secret",
            paired: true,
            pairingCode: nil,
            pairingExpiresAt: nil
        )))
        credentials.rejectedRemovalKeys.insert("installation-credential-v3")
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [UnexpectedRelayDeleteURLProtocol.self]
        UnexpectedRelayDeleteURLProtocol.recorder.reset()
        let manager = PushManager(
            callCoordinator: CallCoordinator(),
            urlSession: URLSession(configuration: sessionConfiguration)
        )
        manager.configuration = subject

        let changedRelay = await manager.changeRelay(to: "https://relay-b.test")
        XCTAssertFalse(changedRelay)

        XCTAssertEqual(UnexpectedRelayDeleteURLProtocol.recorder.snapshot(), 0)
        XCTAssertEqual(subject.validatedRelayURL?.host, "relay-a.test")
        XCTAssertEqual(subject.installationID, "relay-a-installation")
        XCTAssertEqual(subject.installationSecret, "relay-a-secret")
    }

    func testFailedOldRelayDeletionRestoresPreviousBoundConnection() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://relay-a.test"
        )
        XCTAssertTrue(subject.applyRegistration(InstallationRegistration(
            installationID: "relay-a-installation",
            installationSecret: "relay-a-secret",
            paired: true,
            pairingCode: "PAIR-A",
            pairingExpiresAt: Date().addingTimeInterval(60)
        )))
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [FailingRelayDeleteURLProtocol.self]
        let manager = PushManager(
            callCoordinator: CallCoordinator(),
            urlSession: URLSession(configuration: sessionConfiguration)
        )
        manager.configuration = subject

        let changedRelay = await manager.changeRelay(to: "https://relay-b.test")

        XCTAssertFalse(changedRelay)
        XCTAssertEqual(subject.validatedRelayURL?.host, "relay-a.test")
        XCTAssertEqual(subject.installationID, "relay-a-installation")
        XCTAssertEqual(subject.installationSecret, "relay-a-secret")
        XCTAssertEqual(subject.pairingCode, "PAIR-A")
        XCTAssertTrue(subject.agentPaired)
        XCTAssertEqual(subject.state, .failed("Could not disconnect from the current relay"))
    }

    func testFailedRollbackRetainsTransitionJournalForRestartRecovery() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://relay-a.test"
        )
        XCTAssertTrue(subject.applyRegistration(InstallationRegistration(
            installationID: "relay-a-installation",
            installationSecret: "relay-a-secret",
            paired: true,
            pairingCode: nil,
            pairingExpiresAt: nil
        )))
        credentials.rejectedWriteValuesByKey["relay-url"] = ["https://relay-a.test"]
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [FailingRelayDeleteURLProtocol.self]
        let manager = PushManager(
            callCoordinator: CallCoordinator(),
            urlSession: URLSession(configuration: sessionConfiguration)
        )
        manager.configuration = subject

        let changedRelay = await manager.changeRelay(to: "https://relay-b.test")

        XCTAssertFalse(changedRelay)
        XCTAssertNotNil(credentials.values["pending-relay-transition-v1"])
        XCTAssertEqual(
            subject.state,
            .failed("Caller could not restore its previous relay connection")
        )

        credentials.rejectedWriteValuesByKey["relay-url"] = []
        let afterRestart = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://other-default.test"
        )
        XCTAssertEqual(afterRestart.validatedRelayURL?.host, "relay-b.test")
        XCTAssertNotNil(afterRestart.pendingRelayTransition)
    }

    func testPendingRelayTransitionResumesDeletionBeforeRegistrationAfterRestart() async {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        let beforeTermination = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://relay-a.test"
        )
        XCTAssertTrue(beforeTermination.applyRegistration(InstallationRegistration(
            installationID: "relay-a-installation",
            installationSecret: "relay-a-secret",
            paired: true,
            pairingCode: nil,
            pairingExpiresAt: nil
        )))
        let snapshot = beforeTermination.relayConnectionSnapshot()
        XCTAssertTrue(beforeTermination.prepareRelayTransition(
            from: snapshot,
            to: "https://relay-b.test"
        ))
        XCTAssertTrue(beforeTermination.updateRelayURL("https://relay-b.test"))

        let afterRestart = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://other-default.test"
        )
        XCTAssertNotNil(afterRestart.pendingRelayTransition)
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [PendingTransitionResumeURLProtocol.self]
        let manager = PushManager(
            callCoordinator: CallCoordinator(),
            urlSession: URLSession(configuration: sessionConfiguration)
        )
        manager.configuration = afterRestart
        let completed = expectation(description: "old relay cleanup then new registration")
        PendingTransitionResumeURLProtocol.recorder.reset(completed: completed)

        manager.registerCurrentTokenIfPossible()
        for _ in 0..<1_000 where afterRestart.pendingRelayTransition != nil {
            await Task.yield()
        }
        XCTAssertEqual(
            PendingTransitionResumeURLProtocol.recorder.snapshot(),
            ["DELETE relay-a.test"]
        )
        XCTAssertNil(afterRestart.pendingRelayTransition)
        XCTAssertNil(afterRestart.installationID)
        XCTAssertFalse(afterRestart.hasPushToken)

        manager.didReceiveVoIPToken(Data(repeating: 1, count: 32))

        await fulfillment(of: [completed], timeout: 2)
        for _ in 0..<1_000 where afterRestart.installationID != "relay-b-installation" {
            await Task.yield()
        }
        XCTAssertEqual(
            PendingTransitionResumeURLProtocol.recorder.snapshot(),
            ["DELETE relay-a.test", "POST relay-b.test"]
        )
        XCTAssertNil(afterRestart.pendingRelayTransition)
        XCTAssertEqual(afterRestart.installationID, "relay-b-installation")
        XCTAssertEqual(afterRestart.installationSecret, "relay-b-secret")
    }

    func testCredentialBundleIsRefusedWhenStoredRelayOriginDiffers() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        credentials.values["relay-url"] = "https://relay-a.test"
        credentials.values["installation-credential-v3"] = """
        {"installationID":"relay-b-installation","installationSecret":"relay-b-secret","relayOrigin":"https://relay-b.test"}
        """

        let subject = ConnectionConfiguration(
            defaults: suite,
            credentials: credentials,
            defaultRelayURL: "https://default-relay.test"
        )

        XCTAssertEqual(subject.validatedRelayURL?.host, "relay-a.test")
        XCTAssertNil(subject.installationID)
        XCTAssertNil(subject.installationSecret)
        XCTAssertNil(suite.string(forKey: "agentCaller.installationID"))
    }

    func testLegacyPlaceholderMovesToManagedRelayWithoutUsingUnboundCredentials() {
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
        XCTAssertNil(subject.installationID)
        XCTAssertNil(subject.installationSecret)
    }

    func testLegacyMacRelayMovesToManagedRelayWithoutUsingUnboundCredentials() {
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
        XCTAssertNil(subject.installationID)
        XCTAssertNil(subject.installationSecret)
    }

    func testRestoresInstallationIdentityAndRelayFromKeychainAfterDefaultsReset() {
        let suite = UserDefaults(suiteName: UUID().uuidString)!
        let credentials = TestCredentialStore()
        credentials.values["relay-url"] = "https://managed.caller.example"
        credentials.values["installation-credential-v3"] = """
        {"installationID":"installation-1","installationSecret":"private-secret","relayOrigin":"https://managed.caller.example"}
        """

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
