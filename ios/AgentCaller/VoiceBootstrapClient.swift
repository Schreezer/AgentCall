import Foundation

struct VoiceBootstrap: Decodable, Sendable {
    struct XAI: Decodable, Sendable {
        let model: String
        let ephemeralToken: String
        let expiresAt: Date

        enum CodingKeys: String, CodingKey {
            case model
            case ephemeralToken = "ephemeral_token"
            case expiresAt = "expires_at"
        }
    }

    struct Session: Codable, Sendable {
        struct Reasoning: Codable, Sendable { let effort: String }
        struct TurnDetection: Codable, Sendable {
            let type: String
            let silenceDurationMilliseconds: Int

            enum CodingKeys: String, CodingKey {
                case type
                case silenceDurationMilliseconds = "silence_duration_ms"
            }
        }
        struct Resumption: Codable, Sendable { let enabled: Bool }
        struct AudioFormat: Codable, Sendable { let type: String; let rate: Int }
        struct AudioDirection: Codable, Sendable { let format: AudioFormat; let transport: String }
        struct Audio: Codable, Sendable { let input: AudioDirection; let output: AudioDirection }
        struct Tool: Codable, Sendable {
            let type: String
            let serverURL: String
            let serverLabel: String
            let serverDescription: String
            let allowedTools: [String]
            let authorization: String

            enum CodingKeys: String, CodingKey {
                case type, authorization
                case serverURL = "server_url"
                case serverLabel = "server_label"
                case serverDescription = "server_description"
                case allowedTools = "allowed_tools"
            }
        }

        let instructions: String
        let voice: String
        let reasoning: Reasoning
        let turnDetection: TurnDetection
        let resumption: Resumption
        let audio: Audio
        let tools: [Tool]

        enum CodingKeys: String, CodingKey {
            case instructions, voice, reasoning, resumption, audio, tools
            case turnDetection = "turn_detection"
        }
    }

    let callID: String
    let voiceSessionID: String
    let xai: XAI
    let session: Session

    enum CodingKeys: String, CodingKey {
        case xai, session
        case callID = "call_id"
        case voiceSessionID = "voice_session_id"
    }
}

enum VoiceBootstrapError: LocalizedError {
    case invalidConfiguration
    case rejected(Int)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: "Caller is missing its relay credentials."
        case .rejected(let status): "The live voice bootstrap was rejected (HTTP \(status))."
        case .invalidResponse: "The live voice bootstrap response was invalid."
        }
    }
}

struct VoiceBootstrapClient: Sendable {
    let relayURL: URL
    let installationID: String
    let installationSecret: String
    var session: URLSession = .shared

    func create(callID: UUID) async throws -> VoiceBootstrap {
        var request = authenticatedRequest(
            path: "v1/installations/\(installationID)/calls/\(callID.uuidString.lowercased())/voice-bootstrap"
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw VoiceBootstrapError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw VoiceBootstrapError.rejected(http.statusCode) }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(VoiceBootstrap.self, from: data)
    }

    func revoke(voiceSessionID: String) async {
        var request = authenticatedRequest(
            path: "v1/installations/\(installationID)/voice-sessions/\(voiceSessionID)"
        )
        request.httpMethod = "DELETE"
        _ = try? await session.data(for: request)
    }

    private func authenticatedRequest(path: String) -> URLRequest {
        var request = URLRequest(url: relayURL.appending(path: path), timeoutInterval: 15)
        request.setValue("Bearer \(installationSecret)", forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        return request
    }
}
