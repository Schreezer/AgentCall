import SwiftUI

@main
struct AgentCallerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var configuration = ConnectionConfiguration()

    var body: some Scene {
        WindowGroup {
            ConnectionView(
                pushManager: appDelegate.pushManager,
                callCoordinator: appDelegate.callCoordinator
            )
                .environmentObject(configuration)
                .task {
                    appDelegate.configure(with: configuration)
                }
        }
    }
}
