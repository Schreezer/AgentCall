import Foundation

struct IncomingCall: Equatable {
    let id: UUID
    let callerName: String
    let message: String

    init?(payload: [AnyHashable: Any]) {
        guard let rawID = payload["call_id"] as? String,
              let id = UUID(uuidString: rawID),
              let message = payload["message"] as? String else {
            return nil
        }
        self.id = id
        callerName = payload["caller_name"] as? String ?? "Your agent"
        self.message = message
    }

    init(id: UUID, callerName: String, message: String) {
        self.id = id
        self.callerName = callerName
        self.message = message
    }
}
