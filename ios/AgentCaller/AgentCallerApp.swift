import SwiftUI

@main
struct AgentCallerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ConnectionView(
                pushManager: appDelegate.pushManager,
                callCoordinator: appDelegate.callCoordinator
            )
                .environmentObject(appDelegate.configuration)
        }
    }
}
