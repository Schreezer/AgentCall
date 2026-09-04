import Foundation

struct IncomingCall: Equatable {
    let id: UUID
    let callerName: String
    let message: String

    init?(payload: [AnyHashable: Any]) {
        guard payload["mode"] as? String == "live_voice",
              let rawID = payload["call_id"] as? String,
              let id = UUID(uuidString: rawID),
              let message = payload["message"] as? String else {
            return nil
        }
        self.id = id
        callerName = payload["caller_name"] as? String ?? "Your agent"
        self.message = message
    }
}
