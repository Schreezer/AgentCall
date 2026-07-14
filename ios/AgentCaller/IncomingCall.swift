import Foundation

struct IncomingCall: Equatable {
    let id: UUID
    let callerName: String
    let message: String
    let audioRequest: URLRequest?

    init?(payload: [AnyHashable: Any], audioRequest: URLRequest? = nil) {
        guard let rawID = payload["call_id"] as? String,
              let id = UUID(uuidString: rawID),
              let message = payload["message"] as? String else {
            return nil
        }
        self.id = id
        callerName = payload["caller_name"] as? String ?? "Your agent"
        self.message = message
        self.audioRequest = audioRequest
    }

    init(id: UUID, callerName: String, message: String, audioRequest: URLRequest? = nil) {
        self.id = id
        self.callerName = callerName
        self.message = message
        self.audioRequest = audioRequest
    }
}

enum CallAudioRequestFactory {
    static func make(
        payload: [AnyHashable: Any],
        relayURL: URL?,
        installationID: String?,
        installationSecret: String?
    ) -> URLRequest? {
        guard let rawAudioID = payload["audio_id"] as? String,
              UUID(uuidString: rawAudioID) != nil,
              let relayURL,
              let installationID,
              let installationSecret else {
            return nil
        }
        let url = relayURL.appending(path: "v1/installations/\(installationID)/audio/\(rawAudioID)")
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.setValue("Bearer \(installationSecret)", forHTTPHeaderField: "Authorization")
        return request
    }
}
