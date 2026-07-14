import UIKit

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    let callCoordinator = CallCoordinator()
    private(set) lazy var pushManager = PushManager(callCoordinator: callCoordinator)

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        pushManager.start()
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-call") {
            print("CALLER_PREVIEW_SCHEDULED")
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                print("CALLER_PREVIEW_REPORTING")
                callCoordinator.reportIncoming(
                    IncomingCall(
                        id: UUID(),
                        callerName: "Hermes",
                        message: "This is a simulator test of an urgent agent call."
                    )
                )
            }
        }
        #endif
        return true
    }

    func configure(with configuration: ConnectionConfiguration) {
        pushManager.configuration = configuration
        pushManager.registerCurrentTokenIfPossible()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        pushManager.registerCurrentTokenIfPossible()
    }
}
