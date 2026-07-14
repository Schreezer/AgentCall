import XCTest
@testable import AgentCaller

final class IncomingCallTests: XCTestCase {
    func testAudioPushBuildsInstallationScopedDownloadRequest() throws {
        let callID = UUID()
        let audioID = UUID()
        let payload: [AnyHashable: Any] = [
            "call_id": callID.uuidString,
            "caller_name": "Hermes",
            "message": "Text fallback",
            "audio_id": audioID.uuidString,
        ]
        let request = CallAudioRequestFactory.make(
            payload: payload,
            relayURL: URL(string: "https://push.caller.example"),
            installationID: "installation-1",
            installationSecret: "installation-secret"
        )
        let call = try XCTUnwrap(IncomingCall(payload: payload, audioRequest: request))

        XCTAssertEqual(call.id, callID)
        XCTAssertEqual(call.message, "Text fallback")
        XCTAssertEqual(
            call.audioRequest?.url?.absoluteString,
            "https://push.caller.example/v1/installations/installation-1/audio/\(audioID.uuidString)"
        )
        XCTAssertEqual(
            call.audioRequest?.value(forHTTPHeaderField: "Authorization"),
            "Bearer installation-secret"
        )
        XCTAssertEqual(call.audioRequest?.cachePolicy, .reloadIgnoringLocalCacheData)
    }

    func testInvalidAudioIdentifierFallsBackToTextOnly() throws {
        let payload: [AnyHashable: Any] = [
            "call_id": UUID().uuidString,
            "message": "Text fallback",
            "audio_id": "not-an-audio-id",
        ]
        let request = CallAudioRequestFactory.make(
            payload: payload,
            relayURL: URL(string: "https://push.caller.example"),
            installationID: "installation-1",
            installationSecret: "installation-secret"
        )

        XCTAssertNil(request)
        XCTAssertNil(try XCTUnwrap(IncomingCall(payload: payload)).audioRequest)
    }
}
