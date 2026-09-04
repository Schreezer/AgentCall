import SwiftUI

struct CallerSettingsView: View {
    @ObservedObject var configuration: ConnectionConfiguration
    let pushManager: PushManager
    let callCoordinator: CallCoordinator
    @ObservedObject var agentStore: HostedAgentStore

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                if configuration.usesHostedAssistant {
                    HostedAssistantSettingsSection(store: agentStore)
                }
                agentSection
                connectionSection
                diagnosticsSection
                privacySection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }

    @ViewBuilder
    private var agentSection: some View {
        Section {
            statusRow(
                "Personal agent",
                value: agentStatusText,
                ready: configuration.agentPaired || configuration.usesHostedAssistant
            )

            if configuration.hasUsablePairingCode() {
                HStack {
                    Text("Setup")
                    Spacer()
                    Label("Waiting", systemImage: "clock.fill")
                        .foregroundStyle(.blue)
                        .font(.subheadline.weight(.medium))
                }
            } else if configuration.isReadyForAgentSetup {
                Button(configuration.agentPaired ? "Replace connected agent" : "Connect an agent") {
                    pushManager.createPairingCode()
                    dismiss()
                }
                .accessibilityIdentifier("settings-pair-agent-button")
            }
        } header: {
            Text("Agent")
        } footer: {
            Text("Agents receive a credential scoped only to this iPhone. Creating a replacement code keeps the current agent connected until the new one claims it.")
        }
    }

    private var connectionSection: some View {
        Section("Connection") {
            statusRow(
                "Incoming calls",
                value: configuration.hasPushToken ? "Ready" : "Preparing",
                ready: configuration.hasPushToken
            )

            statusRow(
                "Caller relay",
                value: configuration.isReadyForAgentSetup ? "Connected" : "Not ready",
                ready: configuration.isReadyForAgentSetup
            )

            NavigationLink {
                RelaySettingsView(configuration: configuration, pushManager: pushManager)
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Advanced relay settings")
                    Text(configuration.isUsingDefaultRelay ? "Managed relay" : "Custom relay")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var diagnosticsSection: some View {
        if case .failed = configuration.state {
            Section("Diagnostics") {
                Button("Retry registration", systemImage: "arrow.clockwise") {
                    pushManager.registerCurrentTokenIfPossible()
                    dismiss()
                }
            }
        }
    }

    private var privacySection: some View {
        Section("Privacy & permissions") {
            Label("Live AI conversations use Apple's incoming-call service.", systemImage: "phone.connection.fill")
            Label("One-way agent messages arrive as notifications and require notification permission.", systemImage: "bell.badge.fill")
            Label("Apple credentials and the phone's push token stay between Caller and the relay.", systemImage: "lock.shield.fill")
        }
    }

    private var agentStatusText: String {
        if configuration.usesHostedAssistant { return "Built-in assistant" }
        if configuration.agentPaired { return "Connected" }
        if configuration.hasUsablePairingCode() { return "Waiting" }
        return "Not connected"
    }

    private func readinessLabel(_ text: String, ready: Bool) -> some View {
        Label(text, systemImage: ready ? "checkmark.circle.fill" : "circle.dotted")
            .foregroundStyle(ready ? .green : .secondary)
            .font(.subheadline.weight(.medium))
    }

    private func statusRow(_ title: String, value: String, ready: Bool) -> some View {
        HStack(spacing: 12) {
            Text(title)
            Spacer(minLength: 12)
            readinessLabel(value, ready: ready)
        }
    }
}

private struct HostedAssistantSettingsSection: View {
    @ObservedObject var store: HostedAgentStore
    @Environment(\.dismiss) private var dismiss

    @State private var quietStart = Date()
    @State private var quietEnd = Date()
    @State private var dailyCallLimit = 6
    @State private var displayName = ""
    @State private var didLoadSettings = false
    @State private var isConfirmingDisable = false
    @State private var isSaving = false

    var body: some View {
        Section {
            DatePicker("Quiet hours start", selection: $quietStart, displayedComponents: .hourAndMinute)
                .onChange(of: quietStart) { _, _ in saveIfLoaded(["quiet_start": Self.clock(quietStart)]) }
            DatePicker("Quiet hours end", selection: $quietEnd, displayedComponents: .hourAndMinute)
                .onChange(of: quietEnd) { _, _ in saveIfLoaded(["quiet_end": Self.clock(quietEnd)]) }
            Stepper("Calls per day: \(dailyCallLimit)", value: $dailyCallLimit, in: 0...24)
                .onChange(of: dailyCallLimit) { _, value in saveIfLoaded(["daily_call_limit": value]) }
            HStack {
                Text("Name")
                TextField("Assistant", text: $displayName)
                    .multilineTextAlignment(.trailing)
                    .onSubmit { saveIfLoaded(["display_name": displayName]) }
            }
            if let status = store.status {
                LabeledContent("Today", value: "\(status.usage.calls) calls · \(status.usage.turns) messages")
                LabeledContent("Model", value: status.model)
            }
            Button("Turn off built-in assistant", role: .destructive) {
                isConfirmingDisable = true
            }
            .accessibilityIdentifier("disable-hosted-assistant-button")
        } header: {
            Text("Built-in assistant")
        } footer: {
            Text("Quiet hours use this iPhone's time zone. The assistant will not ring you inside them and will move scheduled calls to when they end.")
        }
        .task { loadSettingsIfNeeded() }
        .onChange(of: store.status?.settings) { _, _ in loadSettingsIfNeeded(force: true) }
        .confirmationDialog(
            "Turn off the built-in assistant?",
            isPresented: $isConfirmingDisable,
            titleVisibility: .visible
        ) {
            Button("Turn off and delete its memory", role: .destructive) {
                Task { @MainActor in
                    if await store.disable() { dismiss() }
                }
            }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("Chat history, notes, and schedules are deleted. You can turn it back on any time.")
        }
    }

    private func loadSettingsIfNeeded(force: Bool = false) {
        guard let settings = store.status?.settings, force || !didLoadSettings else { return }
        didLoadSettings = false
        quietStart = Self.date(fromClock: settings.quietStart)
        quietEnd = Self.date(fromClock: settings.quietEnd)
        dailyCallLimit = settings.dailyCallLimit
        displayName = settings.displayName
        // Let the onChange handlers settle before treating edits as user intent.
        Task { @MainActor in didLoadSettings = true }
    }

    private func saveIfLoaded(_ changes: [String: any Sendable]) {
        guard didLoadSettings, !isSaving else { return }
        isSaving = true
        Task { @MainActor in
            _ = await store.updateSettings(changes)
            isSaving = false
        }
    }

    private static func clock(_ date: Date) -> String {
        let components = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", components.hour ?? 0, components.minute ?? 0)
    }

    private static func date(fromClock clock: String) -> Date {
        let parts = clock.split(separator: ":").compactMap { Int($0) }
        var components = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        components.hour = parts.first ?? 0
        components.minute = parts.count > 1 ? parts[1] : 0
        return Calendar.current.date(from: components) ?? Date()
    }
}

private struct RelaySettingsView: View {
    @ObservedObject var configuration: ConnectionConfiguration
    let pushManager: PushManager

    @Environment(\.dismiss) private var dismiss
    @State private var relayDraft: String
    @State private var isSaving = false
    @State private var validationMessage: String?
    @State private var isConfirmingRelayChange = false

    init(configuration: ConnectionConfiguration, pushManager: PushManager) {
        self.configuration = configuration
        self.pushManager = pushManager
        _relayDraft = State(initialValue: configuration.relayURL)
    }

    var body: some View {
        Form {
            Section {
                TextField("https://caller.example.com", text: $relayDraft)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textContentType(.URL)
                    .font(.body.monospaced())
                    .accessibilityIdentifier("settings-relay-url")

                Button("Use managed relay") {
                    relayDraft = configuration.defaultRelayURL
                    validationMessage = nil
                }
                .disabled(relayDraft == configuration.defaultRelayURL)
            } header: {
                Text("Relay URL")
            } footer: {
                Text("Most people should use the managed relay. Changing this disconnects the current installation and requires pairing your agent again.")
            }

            if let validationMessage {
                Section {
                    Label(validationMessage, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Caller relay")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") {
                    saveTapped()
                }
                .disabled(isSaving || relayDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("settings-save-button")
            }
        }
        .confirmationDialog(
            "Change Caller relay?",
            isPresented: $isConfirmingRelayChange,
            titleVisibility: .visible
        ) {
            Button("Change relay", role: .destructive) { saveRelay() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Caller will revoke the current installation, reconnect this iPhone, and require a new agent pairing.")
        }
    }

    private func saveTapped() {
        guard configuration.validatedRelayURL(for: relayDraft) != nil else {
            validationMessage = "Enter a valid HTTPS relay URL. Local development may use localhost."
            return
        }
        validationMessage = nil
        if configuration.wouldChangeRelay(to: relayDraft), configuration.installationID != nil {
            isConfirmingRelayChange = true
        } else {
            saveRelay()
        }
    }

    private func saveRelay() {
        isSaving = true
        Task { @MainActor in
            let saved = await pushManager.changeRelay(to: relayDraft)
            isSaving = false
            if saved {
                dismiss()
            } else {
                validationMessage = configuration.statusText
            }
        }
    }
}
