import Combine
import SwiftUI
import UIKit

struct ConnectionView: View {
    let pushManager: PushManager
    @ObservedObject var callCoordinator: CallCoordinator
    @ObservedObject var approvalStore: HermesApprovalStore

    @EnvironmentObject private var configuration: ConnectionConfiguration
    @Environment(\.colorScheme) private var colorScheme
    @State private var didCopyInstructions = false
    @State private var didCopyFamilyInstructions = false
    @State private var didCopyUpdateInstructions = false
    @State private var isShowingSettings = false
    @State private var now = Date()

    private let pairingPoller = Timer.publish(every: 4, on: .main, in: .common).autoconnect()

    var body: some View {
        ZStack {
            NavigationStack {
                ZStack {
                    background

                    ScrollView {
                        VStack(spacing: 18) {
                            if !approvalStore.approvals.isEmpty {
                                approvalInbox
                            }
                            homeContent
                        }
                            .frame(maxWidth: 520)
                            .padding(.horizontal, 20)
                            .padding(.top, 18)
                            .padding(.bottom, 36)
                            .frame(maxWidth: .infinity)
                    }
                }
                .navigationTitle("Caller")
                .navigationBarTitleDisplayMode(.large)
                .toolbarBackground(.hidden, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        settingsButton
                    }
                }
            }

            if let call = callCoordinator.activeCall {
                ActiveCallView(call: call, coordinator: callCoordinator)
                    .transition(.opacity.combined(with: .scale(scale: 1.02)))
                    .zIndex(10)
            }
        }
        .tint(.blue)
        .sheet(isPresented: $isShowingSettings) {
            CallerSettingsView(
                configuration: configuration,
                pushManager: pushManager,
                callCoordinator: callCoordinator
            )
        }
        .onReceive(pairingPoller) { date in
            now = date
            if configuration.pairingCode != nil {
                pushManager.refreshPairingStatus()
            }
        }
        .onChange(of: callCoordinator.activeCall) { _, activeCall in
            if activeCall != nil { isShowingSettings = false }
        }
        .animation(.snappy(duration: 0.45), value: configuration.homeState(at: now))
        .animation(.easeInOut(duration: 0.25), value: callCoordinator.activeCall)
    }

    private var approvalInbox: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Hermes needs confirmation", systemImage: "checkmark.shield.fill")
                .font(.headline)
                .foregroundStyle(.orange)
            ForEach(approvalStore.approvals) { approval in
                VStack(alignment: .leading, spacing: 12) {
                    Text(approval.details.displayText)
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        ForEach(approval.choices, id: \.self) { choice in
                            approvalButton(approval, choice: choice)
                        }
                    }
                }
                .padding(14)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 16))
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 24))
        .accessibilityIdentifier("hermes-approval-inbox")
    }

    @ViewBuilder
    private func approvalButton(_ approval: HermesApproval, choice: String) -> some View {
        let button = Button(choice.replacingOccurrences(of: "_", with: " ").capitalized) {
            Task { _ = await approvalStore.answer(approval, choice: choice) }
        }
        if choice == "deny" {
            button.buttonStyle(.bordered)
        } else {
            button.buttonStyle(.borderedProminent)
        }
    }

    private var background: some View {
        ZStack {
            Color(uiColor: .systemGroupedBackground)

            LinearGradient(
                colors: [
                    Color.blue.opacity(colorScheme == .dark ? 0.17 : 0.11),
                    Color.cyan.opacity(colorScheme == .dark ? 0.06 : 0.035),
                    .clear
                ],
                startPoint: .topTrailing,
                endPoint: .center
            )
        }
        .ignoresSafeArea()
    }

    @ViewBuilder
    private var homeContent: some View {
        switch configuration.homeState(at: now) {
        case .preparing:
            preparingView
                .transition(.opacity.combined(with: .scale(scale: 0.98)))
        case .readyToPair:
            readyToPairView
                .transition(.opacity.combined(with: .move(edge: .bottom)))
        case .waitingForPairing:
            waitingForPairingView
                .transition(.opacity.combined(with: .move(edge: .bottom)))
        case .paired:
            pairedView
                .transition(.opacity.combined(with: .scale(scale: 0.98)))
        case .needsAttention(let message):
            attentionView(message: message)
                .transition(.opacity.combined(with: .scale(scale: 0.98)))
        }
    }

    private var preparingView: some View {
        statusSurface {
            statusIcon(color: .blue) {
                ProgressView()
                    .controlSize(.large)
                    .tint(.blue)
            }

            statusCopy(
                title: "Preparing Caller…",
                subtitle: "Registering this iPhone for incoming calls. This normally takes only a few seconds."
            )

            Label(preparingDetail, systemImage: "lock.shield.fill")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("preparing-status")
    }

    private var readyToPairView: some View {
        statusSurface {
            statusIcon(systemImage: "person.crop.circle.badge.plus", color: .blue)

            statusCopy(
                title: "Connect your agent",
                subtitle: "Give your personal agent permission to send notifications and start live AI calls on this iPhone."
            )

            prominentButton(title: "Create setup instructions", systemImage: "key.fill") {
                pushManager.createPairingCode()
            }
            .accessibilityIdentifier("new-pairing-code-button")

            Text("The setup code is private, expires automatically, and never exposes Apple credentials.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .accessibilityIdentifier("agent-setup-card")
    }

    private var waitingForPairingView: some View {
        statusSurface {
            statusIcon(systemImage: "person.crop.circle.badge.clock", color: .blue)

            statusCopy(
                title: configuration.agentPaired ? "Replace your agent" : "Connect your agent",
                subtitle: configuration.agentPaired
                    ? "Your current agent remains connected until the replacement finishes setup."
                    : "Send the private setup instructions to Hermes, PersonalClaw, or another compatible agent."
            )

            if let code = configuration.pairingCode {
                pairingCodeView(code)
            }

            copyInstructionsButton

            copyFamilyInstructionsButton

            Text("Setting this phone up for a parent or another family member? Copy the family instructions instead and paste them into your own agent.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            HStack(spacing: 9) {
                ProgressView()
                    .controlSize(.small)
                Text("Waiting for your agent…")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("pairing-status")
        }
        .accessibilityIdentifier("agent-setup-card")
    }

    private var pairedView: some View {
        statusSurface {
            statusIcon(systemImage: "phone.connection.fill", color: .green)

            statusCopy(
                title: "Ready",
                subtitle: "Your personal agent can send notifications and start live AI calls when something cannot wait."
            )

            Label("Notifications and live calls enabled", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.green)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Color.green.opacity(0.11), in: Capsule())
                .accessibilityIdentifier("connection-status")

            copyUpdateInstructionsButton

            Text("Paste these instructions into your connected agent. Your existing pairing stays unchanged.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .accessibilityIdentifier("paired-status")
    }

    private func attentionView(message: String) -> some View {
        statusSurface {
            statusIcon(systemImage: "exclamationmark.triangle.fill", color: .orange)

            statusCopy(
                title: "Caller needs attention",
                subtitle: message
            )

            prominentButton(title: "Try again", systemImage: "arrow.clockwise") {
                pushManager.registerCurrentTokenIfPossible()
            }
            .accessibilityIdentifier("retry-connection-button")

            Button("View diagnostics") {
                isShowingSettings = true
            }
            .font(.subheadline.weight(.semibold))
            .accessibilityIdentifier("view-diagnostics-button")
        }
        .accessibilityIdentifier("attention-status")
    }

    private func statusSurface<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 22) {
            content()
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 30)
        .frame(maxWidth: .infinity)
        .cardStyle(cornerRadius: 30, colorScheme: colorScheme)
        .accessibilityIdentifier("home-status-card")
    }

    private func statusIcon(systemImage: String, color: Color) -> some View {
        statusIcon(color: color) {
            Image(systemName: systemImage)
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(color)
        }
    }

    private func statusIcon<Content: View>(color: Color, @ViewBuilder content: () -> Content) -> some View {
        ZStack {
            Circle()
                .fill(color.opacity(0.11))
            Circle()
                .stroke(color.opacity(0.1), lineWidth: 1)
            content()
        }
        .frame(width: 84, height: 84)
        .accessibilityHidden(true)
    }

    private func statusCopy(title: String, subtitle: String) -> some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.title2.bold())
                .multilineTextAlignment(.center)
            Text(subtitle)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func pairingCodeView(_ code: String) -> some View {
        VStack(spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text("PAIRING CODE")
                    .font(.caption2.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(.secondary)

                Spacer()

                if let expiresAt = configuration.pairingExpiresAt {
                    Text(expiresAt, style: .relative)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }

            Text(code)
                .font(.system(.title2, design: .monospaced, weight: .bold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .accessibilityIdentifier("pairing-code")
        }
        .padding(16)
        .background(Color.blue.opacity(0.075), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var preparingDetail: String {
        switch configuration.state {
        case .connecting: "Connecting securely to the Caller relay"
        default: "Waiting for Apple's incoming-call service"
        }
    }

    private var settingsButton: some View {
        Button {
            isShowingSettings = true
        } label: {
            Image(systemName: "gearshape.fill")
                .font(.body.weight(.semibold))
        }
        .accessibilityLabel("Settings")
        .accessibilityIdentifier("settings-button")
    }

    @ViewBuilder
    private var copyInstructionsButton: some View {
        let button = Button {
            guard configuration.hasUsablePairingCode(at: now) else { return }
            UIPasteboard.general.string = AgentSetupInstructions.text(
                relayURL: configuration.relayURL,
                pairingCode: configuration.pairingCode
            )
            didCopyInstructions = true
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                didCopyInstructions = false
            }
        } label: {
            Label(
                didCopyInstructions ? "Instructions copied" : "Copy setup instructions",
                systemImage: didCopyInstructions ? "checkmark" : "doc.on.doc"
            )
            .font(.headline)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 52)
        }
        .accessibilityIdentifier("copy-agent-instructions-button")

        if #available(iOS 26.0, *) {
            button
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.roundedRectangle(radius: 17))
        } else {
            button
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 17))
        }
    }

    @ViewBuilder
    private var copyFamilyInstructionsButton: some View {
        let button = Button {
            guard configuration.hasUsablePairingCode(at: now) else { return }
            UIPasteboard.general.string = AgentSetupInstructions.familyText(
                relayURL: configuration.relayURL,
                pairingCode: configuration.pairingCode
            )
            didCopyFamilyInstructions = true
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                didCopyFamilyInstructions = false
            }
        } label: {
            Label(
                didCopyFamilyInstructions ? "Family instructions copied" : "Set up for a family member",
                systemImage: didCopyFamilyInstructions ? "checkmark" : "figure.2"
            )
            .font(.headline)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 52)
        }
        .accessibilityIdentifier("copy-family-instructions-button")

        button
            .buttonStyle(.bordered)
            .buttonBorderShape(.roundedRectangle(radius: 17))
    }

    @ViewBuilder
    private var copyUpdateInstructionsButton: some View {
        let button = Button {
            UIPasteboard.general.string = AgentSetupInstructions.updateText(
                relayURL: configuration.relayURL
            )
            didCopyUpdateInstructions = true
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                didCopyUpdateInstructions = false
            }
        } label: {
            Label(
                didCopyUpdateInstructions ? "Update instructions copied" : "Update connected agent",
                systemImage: didCopyUpdateInstructions ? "checkmark" : "arrow.down.circle"
            )
            .font(.headline)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 52)
        }
        .accessibilityIdentifier("copy-agent-update-instructions-button")

        if #available(iOS 26.0, *) {
            button
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.roundedRectangle(radius: 17))
        } else {
            button
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 17))
        }
    }

    @ViewBuilder
    private func prominentButton(title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        let button = Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.headline)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 52)
        }

        if #available(iOS 26.0, *) {
            button
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.roundedRectangle(radius: 17))
        } else {
            button
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 17))
        }
    }
}

private struct ActiveCallView: View {
    let call: ActiveCallPresentation
    @ObservedObject var coordinator: CallCoordinator

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.06, green: 0.09, blue: 0.14), Color.black],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer(minLength: 52)

                Image(systemName: "waveform.circle.fill")
                    .font(.system(size: 92, weight: .regular))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, Color.blue)
                    .accessibilityHidden(true)

                Text(call.callerName)
                    .font(.system(size: 34, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.top, 24)

                Text("Live AI voice")
                    .font(.headline)
                    .foregroundStyle(.white.opacity(0.68))
                    .padding(.top, 7)

                TimelineView(.periodic(from: call.connectedAt, by: 1)) { context in
                    Text(callDuration(at: context.date))
                        .font(.system(.body, design: .monospaced).weight(.medium))
                        .foregroundStyle(.white.opacity(0.8))
                        .contentTransition(.numericText())
                }
                .padding(.top, 9)

                Text("Audio: \(coordinator.audioRouteName)")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.white.opacity(0.55))
                    .padding(.top, 12)

                Spacer()

                HStack(spacing: 22) {
                    callButton(
                        title: "Mute",
                        systemImage: coordinator.isMuted ? "mic.slash.fill" : "mic.fill",
                        selected: coordinator.isMuted,
                        action: coordinator.toggleMute
                    )

                    callButton(
                        title: "Speaker",
                        systemImage: "speaker.wave.3.fill",
                        selected: coordinator.isSpeakerEnabled,
                        action: coordinator.toggleSpeaker
                    )

                    audioRouteMenu
                }

                Button(action: coordinator.endActiveCall) {
                    VStack(spacing: 10) {
                        Image(systemName: "phone.down.fill")
                            .font(.system(size: 28, weight: .semibold))
                            .frame(width: 72, height: 72)
                            .background(Color.red, in: Circle())
                        Text("End")
                            .font(.footnote.weight(.medium))
                    }
                    .foregroundStyle(.white)
                }
                .accessibilityLabel("End call")
                .padding(.top, 44)
                .padding(.bottom, 42)
            }
            .padding(.horizontal, 24)
        }
        .accessibilityIdentifier("active-call-screen")
    }

    private var audioRouteMenu: some View {
        Menu {
            ForEach(coordinator.availableAudioRoutes) { route in
                Button {
                    coordinator.selectAudioRoute(route)
                } label: {
                    Label(route.name, systemImage: route.systemImage)
                }
            }
        } label: {
            CallControlLabel(title: "Audio", systemImage: "airplayaudio", selected: false)
        }
        .accessibilityLabel("Choose audio route")
    }

    private func callButton(
        title: String,
        systemImage: String,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            CallControlLabel(title: title, systemImage: systemImage, selected: selected)
        }
        .accessibilityValue(selected ? "On" : "Off")
    }

    private func callDuration(at date: Date) -> String {
        let elapsed = max(0, Int(date.timeIntervalSince(call.connectedAt)))
        return String(format: "%02d:%02d", elapsed / 60, elapsed % 60)
    }
}

private struct CallControlLabel: View {
    let title: String
    let systemImage: String
    let selected: Bool

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 24, weight: .semibold))
                .frame(width: 68, height: 68)
                .foregroundStyle(selected ? .black : .white)
                .background(selected ? Color.white : Color.white.opacity(0.16), in: Circle())
            Text(title)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.white)
        }
        .frame(minWidth: 80)
    }
}

private extension View {
    func cardStyle(cornerRadius: CGFloat, colorScheme: ColorScheme) -> some View {
        background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .stroke(Color.primary.opacity(0.055), lineWidth: 1)
        }
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.18 : 0.045), radius: 20, y: 8)
    }
}
