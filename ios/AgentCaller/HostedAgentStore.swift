import Foundation

/// View model for the built-in assistant: transcript, live reply streaming, schedules, and settings.
@MainActor
final class HostedAgentStore: ObservableObject {
    struct PendingReply: Equatable {
        var text = ""
        var activeTool: String?
    }

    @Published private(set) var messages: [AgentMessage] = []
    @Published private(set) var pendingReply: PendingReply?
    @Published private(set) var schedules: [AgentSchedule] = []
    @Published private(set) var status: AgentStatus?
    @Published private(set) var isLoading = false
    @Published private(set) var isBusy = false
    @Published var errorMessage: String?

    weak var configuration: ConnectionConfiguration?

    private var loadTask: Task<Void, Never>?

    var isStreaming: Bool { pendingReply != nil }

    // MARK: Enable / disable

    func enable(displayName: String? = nil) async -> Bool {
        guard let configuration, let client = makeClient() else {
            errorMessage = HostedAgentError.invalidConfiguration.localizedDescription
            return false
        }
        isBusy = true
        defer { isBusy = false }
        do {
            let registration = try await client.enable(
                timezone: TimeZone.current.identifier,
                displayName: displayName
            )
            _ = configuration.applyRegistration(registration)
            configuration.markAgentMode(.hosted)
            errorMessage = nil
            load()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func disable() async -> Bool {
        guard let configuration, let client = makeClient() else { return false }
        isBusy = true
        defer { isBusy = false }
        do {
            try await client.disable()
            configuration.markAgentMode(.external)
            messages = []
            schedules = []
            status = nil
            pendingReply = nil
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    // MARK: Loading

    func load() {
        guard let client = makeClient(), configuration?.usesHostedAssistant == true else { return }
        loadTask?.cancel()
        isLoading = messages.isEmpty
        loadTask = Task { [weak self] in
            defer { self?.isLoading = false }
            do {
                async let history = client.messages()
                async let schedules = client.schedules()
                async let status = client.status()
                let (loadedHistory, loadedSchedules, loadedStatus) = try await (history, schedules, status)
                try Task.checkCancellation()
                self?.messages = loadedHistory
                self?.schedules = loadedSchedules
                self?.status = loadedStatus
                self?.errorMessage = nil
            } catch is CancellationError {
                return
            } catch {
                self?.errorMessage = error.localizedDescription
            }
        }
    }

    func refreshSchedules() async {
        guard let client = makeClient() else { return }
        do {
            schedules = try await client.schedules()
            status = try await client.status()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: Chat

    func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isStreaming, let client = makeClient() else { return }
        let localID = -(Int(Date().timeIntervalSince1970 * 1000))
        messages.append(AgentMessage(
            id: localID,
            role: "user",
            kind: "text",
            text: trimmed,
            tools: [],
            source: "chat",
            createdAt: Date()
        ))
        pendingReply = PendingReply()
        errorMessage = nil
        var finalText = ""
        var usedTools: [String] = []
        do {
            for try await event in client.chat(message: trimmed) {
                switch event {
                case .text(let delta):
                    pendingReply?.text += delta
                case .tool(let name, let status, _):
                    if status == "running" {
                        pendingReply?.activeTool = name
                        if !usedTools.contains(name) { usedTools.append(name) }
                    } else {
                        pendingReply?.activeTool = nil
                    }
                case .done(_, let text):
                    finalText = text
                case .failure(let code):
                    errorMessage = Self.describe(code)
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        let replyText = finalText.isEmpty ? (pendingReply?.text ?? "") : finalText
        pendingReply = nil
        if !replyText.isEmpty || !usedTools.isEmpty {
            messages.append(AgentMessage(
                id: localID - 1,
                role: "assistant",
                kind: "blocks",
                text: replyText,
                tools: usedTools,
                source: "chat",
                createdAt: Date()
            ))
        }
        if !usedTools.isEmpty { await refreshSchedules() }
    }

    // MARK: Schedules & settings

    func cancel(_ schedule: AgentSchedule) async {
        guard let client = makeClient() else { return }
        do {
            try await client.cancelSchedule(id: schedule.id)
            schedules.removeAll { $0.id == schedule.id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func updateSettings(_ changes: [String: any Sendable]) async -> Bool {
        guard let client = makeClient() else { return false }
        do {
            let settings = try await client.updateSettings(changes)
            if let status {
                self.status = AgentStatus(
                    enabledAt: status.enabledAt,
                    settings: settings,
                    usage: status.usage,
                    limits: status.limits,
                    scheduleCount: status.scheduleCount,
                    model: status.model
                )
            }
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    // MARK: Helpers

    private func makeClient() -> HostedAgentClient? {
        guard let configuration,
              let relayURL = configuration.validatedRelayURL,
              let installationID = configuration.installationID,
              let installationSecret = configuration.installationSecret else { return nil }
        return HostedAgentClient(
            relayURL: relayURL,
            installationID: installationID,
            installationSecret: installationSecret
        )
    }

    private static func describe(_ code: String) -> String {
        switch code {
        case "assistant_credentials_invalid": "The relay's assistant credentials were rejected."
        case "assistant_rate_limited": "The assistant is rate limited right now. Try again shortly."
        case "assistant_timeout": "The assistant took too long to answer."
        default: "The assistant could not finish that reply."
        }
    }
}
