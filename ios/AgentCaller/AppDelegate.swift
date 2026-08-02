import UIKit

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    let configuration = ConnectionConfiguration()
    let callCoordinator = CallCoordinator()
    private(set) lazy var pushManager = PushManager(callCoordinator: callCoordinator)

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        callCoordinator.configuration = configuration
        pushManager.configuration = configuration
        pushManager.approvalStore.configuration = configuration
        pushManager.start()
        application.registerForRemoteNotifications()
        callCoordinator.prepareMicrophonePermission()
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

    func applicationDidBecomeActive(_ application: UIApplication) {
        pushManager.registerCurrentTokenIfPossible()
        pushManager.refreshApprovals()
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        pushManager.didRegisterAlertToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        pushManager.didFailToRegisterAlertToken(error)
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        pushManager.didReceiveAlertNotification(userInfo, completion: completionHandler)
    }
}
