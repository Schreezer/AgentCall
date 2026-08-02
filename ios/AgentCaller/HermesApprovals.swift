import Foundation

enum JSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .bool(item) }
        else if let item = try? value.decode(Double.self) { self = .number(item) }
        else if let item = try? value.decode(String.self) { self = .string(item) }
        else if let item = try? value.decode([String: JSONValue].self) { self = .object(item) }
        else { self = .array(try value.decode([JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .string(let item): try value.encode(item)
        case .number(let item): try value.encode(item)
        case .bool(let item): try value.encode(item)
        case .object(let item): try value.encode(item)
        case .array(let item): try value.encode(item)
        case .null: try value.encodeNil()
        }
    }

    var displayText: String {
        switch self {
        case .string(let value): value
        case .number(let value): String(value)
        case .bool(let value): value ? "Yes" : "No"
        case .null: "None"
        case .array(let values): values.map(\.displayText).joined(separator: ", ")
        case .object(let values):
            values.sorted(by: { $0.key < $1.key })
                .map { "\($0.key.replacingOccurrences(of: "_", with: " ").capitalized): \($0.value.displayText)" }
                .joined(separator: "\n")
        }
    }
}

struct HermesApproval: Decodable, Equatable, Identifiable, Sendable {
    let operationID: String
    let notificationID: String
    let details: JSONValue
    let choices: [String]
    let status: String
    let createdAt: Date
    let expiresAt: Date

    var id: String { operationID }

    enum CodingKeys: String, CodingKey {
        case details, choices, status
        case operationID = "operation_id"
        case notificationID = "notification_id"
        case createdAt = "created_at"
        case expiresAt = "expires_at"
    }
}

@MainActor
final class HermesApprovalStore: ObservableObject {
    @Published private(set) var approvals: [HermesApproval] = []
    @Published private(set) var errorMessage: String?

    weak var configuration: ConnectionConfiguration?
    private var refreshTask: Task<Void, Never>?

    func refresh() {
        refreshTask?.cancel()
        guard let request = makeRequest(path: "hermes-approvals") else { return }
        refreshTask = Task { [weak self] in
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                try Task.checkCancellation()
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                let result = try decoder.decode(ApprovalInbox.self, from: data)
                self?.approvals = result.approvals.filter { $0.status == "pending" && $0.expiresAt > Date() }
                self?.errorMessage = nil
            } catch is CancellationError {
                return
            } catch {
                self?.errorMessage = "Could not refresh Hermes approvals."
            }
        }
    }

    func answer(_ approval: HermesApproval, choice: String) async -> Bool {
        guard approval.choices.contains(choice),
              var request = makeRequest(path: "hermes-operations/\(approval.operationID)/approval") else {
            return false
        }
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["choice": choice])
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }
            approvals.removeAll { $0.id == approval.id }
            errorMessage = nil
            return true
        } catch {
            errorMessage = "Hermes did not accept that approval response."
            return false
        }
    }

    private func makeRequest(path: String) -> URLRequest? {
        guard let configuration,
              let relayURL = configuration.validatedRelayURL,
              let installationID = configuration.installationID,
              let installationSecret = configuration.installationSecret else { return nil }
        var request = URLRequest(
            url: relayURL.appending(path: "v1/installations/\(installationID)/\(path)"),
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 15
        )
        request.setValue("Bearer \(installationSecret)", forHTTPHeaderField: "Authorization")
        return request
    }
}

private struct ApprovalInbox: Decodable { let approvals: [HermesApproval] }
