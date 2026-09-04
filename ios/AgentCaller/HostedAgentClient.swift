import Foundation

/// One line of the hosted assistant's chat transcript as stored by the relay.
struct AgentMessage: Decodable, Identifiable, Equatable, Sendable {
    let id: Int
    let role: String
    let kind: String
    let text: String
    let tools: [String]
    let source: String
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, role, kind, text, tools, source
        case createdAt = "created_at"
    }

    var isUser: Bool { role == "user" }
    var isNote: Bool { kind == "note" }
}

struct AgentSchedule: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let instruction: String
    let type: String
    let nextRunAt: Date
    let cron: String?

    enum CodingKeys: String, CodingKey {
        case id, label, instruction, type, cron
        case nextRunAt = "next_run_at"
    }
}

struct AgentSettings: Codable, Equatable, Sendable {
    var timezone: String
    var quietStart: String
    var quietEnd: String
    var dailyCallLimit: Int
    var callerName: String
    var displayName: String
}

struct AgentStatus: Decodable, Equatable, Sendable {
    struct Usage: Decodable, Equatable, Sendable {
        let day: String
        let calls: Int
        let turns: Int
    }

    struct Limits: Decodable, Equatable, Sendable {
        let dailyCallLimit: Int
        let dailyTurnLimit: Int

        enum CodingKeys: String, CodingKey {
            case dailyCallLimit = "daily_call_limit"
            case dailyTurnLimit = "daily_turn_limit"
        }
    }

    let enabledAt: Date?
    let settings: AgentSettings
    let usage: Usage
    let limits: Limits
    let scheduleCount: Int
    let model: String

    enum CodingKeys: String, CodingKey {
        case settings, usage, limits, model
        case enabledAt = "enabled_at"
        case scheduleCount = "schedule_count"
    }
}

/// Server-sent event emitted while the assistant answers.
enum AgentChatEvent: Equatable, Sendable {
    case text(String)
    case tool(name: String, status: String, summary: String?)
    case done(messageID: Int?, text: String)
    case failure(String)

    init?(json: [String: Any]) {
        switch json["type"] as? String {
        case "text":
            self = .text(json["delta"] as? String ?? "")
        case "tool":
            self = .tool(
                name: json["name"] as? String ?? "",
                status: json["status"] as? String ?? "",
                summary: json["summary"] as? String
            )
        case "done":
            self = .done(messageID: json["message_id"] as? Int, text: json["text"] as? String ?? "")
        case "error":
            self = .failure(json["error"] as? String ?? "assistant_failed")
        default:
            return nil
        }
    }
}

enum HostedAgentError: LocalizedError, Equatable {
    case invalidConfiguration
    case rejected(Int, String?)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: "Caller is missing its relay credentials."
        case .rejected(let status, let code):
            switch code {
            case "hosted_agent_not_available": "The built-in assistant is not enabled on this relay."
            case "daily_turn_limit_reached": "The assistant reached today's message limit."
            case "turn_in_progress": "The assistant is still answering. Try again in a moment."
            case "rate_limited": "Slow down a little; too many messages were sent."
            default: "The relay rejected the request (HTTP \(status))."
            }
        case .invalidResponse: "The relay returned an unexpected response."
        }
    }
}

/// Installation-authenticated client for the relay's `/v1/installations/{id}/agent` surface.
struct HostedAgentClient: Sendable {
    let relayURL: URL
    let installationID: String
    let installationSecret: String
    var session: URLSession = .shared

    func enable(timezone: String, displayName: String?) async throws -> InstallationRegistration {
        var body: [String: Any] = ["timezone": timezone]
        if let displayName, !displayName.isEmpty { body["display_name"] = displayName }
        let data = try await send(path: "agent/enable", method: "POST", body: body)
        return try Self.decoder.decode(InstallationRegistration.self, from: data)
    }

    func disable() async throws {
        _ = try await send(path: "agent", method: "DELETE")
    }

    func status() async throws -> AgentStatus {
        try Self.decoder.decode(AgentStatus.self, from: try await send(path: "agent/status"))
    }

    func messages(before: Int? = nil, limit: Int = 50) async throws -> [AgentMessage] {
        var query = "limit=\(limit)"
        if let before { query += "&before=\(before)" }
        let data = try await send(path: "agent/messages?\(query)")
        return try Self.decoder.decode(MessagesPage.self, from: data).messages
    }

    func schedules() async throws -> [AgentSchedule] {
        try Self.decoder.decode(SchedulesPage.self, from: try await send(path: "agent/schedules")).schedules
    }

    func cancelSchedule(id: String) async throws {
        _ = try await send(path: "agent/schedules/\(id)", method: "DELETE")
    }

    func updateSettings(_ changes: [String: any Sendable]) async throws -> AgentSettings {
        let data = try await send(path: "agent/settings", method: "PUT", body: changes as [String: Any])
        return try Self.decoder.decode(SettingsPage.self, from: data).settings
    }

    /// Streams the assistant's reply. The stream finishes after the `done` or `error` event.
    func chat(message: String) -> AsyncThrowingStream<AgentChatEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = authenticatedRequest(path: "agent/chat", timeout: 180)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    request.httpBody = try JSONSerialization.data(withJSONObject: ["message": message])
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else { throw HostedAgentError.invalidResponse }
                    guard (200..<300).contains(http.statusCode) else {
                        var payload = Data()
                        for try await byte in bytes { payload.append(byte) }
                        throw HostedAgentError.rejected(http.statusCode, Self.errorCode(in: payload))
                    }
                    for try await line in bytes.lines {
                        guard line.hasPrefix("data: "),
                              let data = line.dropFirst(6).data(using: .utf8),
                              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let event = AgentChatEvent(json: object) else { continue }
                        continuation.yield(event)
                        if case .done = event { break }
                        if case .failure = event { break }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func send(path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        var request = authenticatedRequest(path: path, timeout: 20)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw HostedAgentError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw HostedAgentError.rejected(http.statusCode, Self.errorCode(in: data))
        }
        return data
    }

    private func authenticatedRequest(path: String, timeout: TimeInterval) -> URLRequest {
        var request = URLRequest(
            url: relayURL.appending(path: "v1/installations/\(installationID)/").appending(path: path),
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: timeout
        )
        request.setValue("Bearer \(installationSecret)", forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        return request
    }

    private static func errorCode(in data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
    }

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    private struct MessagesPage: Decodable { let messages: [AgentMessage] }
    private struct SchedulesPage: Decodable { let schedules: [AgentSchedule] }
    private struct SettingsPage: Decodable { let settings: AgentSettings }
}

private extension URL {
    func appending(path: String) -> URL {
        // `URL.appending(path:)` percent-encodes "?" so query strings need manual handling.
        if let separator = path.firstIndex(of: "?") {
            let base = appending(component: String(path[..<separator]))
            var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
            components?.percentEncodedQuery = String(path[path.index(after: separator)...])
            return components?.url ?? base
        }
        return appending(component: path)
    }

    func appending(component: String) -> URL {
        var url = self
        for segment in component.split(separator: "/") where !segment.isEmpty {
            url.append(path: String(segment))
        }
        return url
    }
}
