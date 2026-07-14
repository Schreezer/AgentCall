import SwiftUI

struct CallerSettingsView: View {
    @ObservedObject var configuration: ConnectionConfiguration
    let pushManager: PushManager
    let callCoordinator: CallCoordinator

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
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
            statusRow("Personal agent", value: agentStatusText, ready: configuration.agentPaired)

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
        Section {
            if case .failed = configuration.state {
                Button("Retry registration", systemImage: "arrow.clockwise") {
                    pushManager.registerCurrentTokenIfPossible()
                    dismiss()
                }
            }

            #if DEBUG
            Button("Test incoming call", systemImage: "phone.badge.waveform") {
                callCoordinator.reportIncoming(
                    IncomingCall(
                        id: UUID(),
                        callerName: "Hermes",
                        message: "This is a preview of an urgent agent call."
                    )
                )
            }
            .accessibilityIdentifier("preview-call-button")
            #endif
        } header: {
            Text("Diagnostics")
        } footer: {
            Text("A test call uses the system incoming-call interface but does not contact your agent.")
        }
    }

    private var privacySection: some View {
        Section("Privacy & permissions") {
            Label("VoIP calls use Apple's incoming-call service. Notification permission is not required.", systemImage: "phone.connection.fill")
            Label("Microphone access is not required for one-way spoken reminders.", systemImage: "mic.slash.fill")
            Label("Apple credentials and the phone's push token stay between Caller and the relay.", systemImage: "lock.shield.fill")
        }
    }

    private var agentStatusText: String {
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
