import SwiftUI
import UIKit

struct AgentChatView: View {
    @ObservedObject var store: HostedAgentStore

    @State private var draft = ""
    @State private var isShowingSchedules = false
    @FocusState private var isComposing: Bool

    private let bottomAnchor = "chat-bottom"

    var body: some View {
        VStack(spacing: 0) {
            transcript
            composer
        }
        .navigationTitle(store.status?.settings.displayName.capitalized ?? "Assistant")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    isShowingSchedules = true
                } label: {
                    Label("Schedules", systemImage: "calendar.badge.clock")
                }
                .accessibilityIdentifier("agent-schedules-button")
            }
        }
        .sheet(isPresented: $isShowingSchedules) {
            AgentSchedulesView(store: store)
        }
        .task { store.load() }
        .refreshable { await store.refreshSchedules() }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    if store.isLoading {
                        ProgressView()
                            .padding(.top, 40)
                    } else if store.messages.isEmpty, store.pendingReply == nil {
                        emptyState
                    }

                    ForEach(store.messages) { message in
                        AgentMessageBubble(message: message)
                            .id(message.id)
                    }

                    if let pending = store.pendingReply {
                        PendingReplyBubble(reply: pending)
                    }

                    if let errorMessage = store.errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id(bottomAnchor)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: store.messages.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: store.pendingReply?.text) { _, _ in scrollToBottom(proxy) }
            .onAppear { scrollToBottom(proxy, animated: false) }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "sparkles")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(.blue)
            Text("Ask for a call, a reminder, or a recurring check-in.")
                .font(.headline)
                .multilineTextAlignment(.center)
            Text("Try: \"Call me tomorrow at 7am and ask how I slept\"")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 60)
        .padding(.horizontal, 24)
        .accessibilityIdentifier("agent-chat-empty")
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Message your assistant", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .focused($isComposing)
                .onSubmit(send)
                .accessibilityIdentifier("agent-chat-input")

            Button(action: send) {
                Image(systemName: store.isStreaming ? "ellipsis.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(canSend ? Color.blue : Color.secondary)
            }
            .disabled(!canSend)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("agent-chat-send")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var canSend: Bool {
        !store.isStreaming && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard canSend else { return }
        let text = draft
        draft = ""
        Task { await store.send(text) }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        if animated {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomAnchor, anchor: .bottom) }
        } else {
            proxy.scrollTo(bottomAnchor, anchor: .bottom)
        }
    }
}

private struct AgentMessageBubble: View {
    let message: AgentMessage

    var body: some View {
        if message.isNote {
            Text(message.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
        } else {
            HStack {
                if message.isUser { Spacer(minLength: 48) }
                VStack(alignment: message.isUser ? .trailing : .leading, spacing: 6) {
                    if message.source != "chat" {
                        Text(sourceLabel)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    if !message.text.isEmpty {
                        Text(message.text)
                            .textSelection(.enabled)
                    }
                    if !message.tools.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(message.tools, id: \.self) { tool in
                                Label(Self.toolTitle(tool), systemImage: Self.toolIcon(tool))
                                    .font(.caption2.weight(.medium))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(Color.blue.opacity(0.1), in: Capsule())
                            }
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    message.isUser ? Color.blue : Color(uiColor: .secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
                .foregroundStyle(message.isUser ? Color.white : Color.primary)
                if !message.isUser { Spacer(minLength: 48) }
            }
        }
    }

    private var sourceLabel: String {
        switch message.source {
        case "schedule": "Scheduled task"
        case "voice": "During a call"
        default: message.source.capitalized
        }
    }

    static func toolTitle(_ tool: String) -> String {
        switch tool {
        case "place_call": "Called you"
        case "send_notification": "Sent a notification"
        case "create_schedule": "Scheduled"
        case "cancel_schedule": "Cancelled a schedule"
        case "list_schedules": "Checked schedules"
        case "remember": "Remembered"
        case "recall": "Recalled"
        case "web_search": "Searched the web"
        default: tool.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    static func toolIcon(_ tool: String) -> String {
        switch tool {
        case "place_call": "phone.fill"
        case "send_notification": "bell.fill"
        case "create_schedule", "list_schedules": "calendar.badge.clock"
        case "cancel_schedule": "calendar.badge.minus"
        case "remember", "recall": "brain"
        case "web_search": "magnifyingglass"
        default: "wrench"
        }
    }
}

private struct PendingReplyBubble: View {
    let reply: HostedAgentStore.PendingReply

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 8) {
                if let tool = reply.activeTool {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(Self.activity(tool))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                }
                if reply.text.isEmpty, reply.activeTool == nil {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Thinking…")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                } else if !reply.text.isEmpty {
                    Text(reply.text)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            Spacer(minLength: 48)
        }
        .accessibilityIdentifier("agent-chat-pending")
    }

    private static func activity(_ tool: String) -> String {
        switch tool {
        case "place_call": "Placing a call…"
        case "send_notification": "Sending a notification…"
        case "create_schedule": "Scheduling…"
        case "web_search": "Searching the web…"
        case "remember": "Saving a note…"
        case "recall": "Checking notes…"
        default: "Working…"
        }
    }
}

struct AgentSchedulesView: View {
    @ObservedObject var store: HostedAgentStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if store.schedules.isEmpty {
                    ContentUnavailableView(
                        "No schedules yet",
                        systemImage: "calendar.badge.clock",
                        description: Text("Ask the assistant to call or remind you at a specific time and it will show up here.")
                    )
                } else {
                    ForEach(store.schedules) { schedule in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(schedule.label)
                                .font(.headline)
                            Text(schedule.instruction)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            HStack(spacing: 6) {
                                Image(systemName: schedule.type == "cron" ? "repeat" : "clock")
                                Text(schedule.type == "cron" ? "Repeats · next " : "Once · ")
                                    + Text(schedule.nextRunAt, style: .relative)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                        .swipeActions {
                            Button(role: .destructive) {
                                Task { await store.cancel(schedule) }
                            } label: {
                                Label("Cancel", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            .navigationTitle("Schedules")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .refreshable { await store.refreshSchedules() }
            .task { await store.refreshSchedules() }
        }
    }
}
