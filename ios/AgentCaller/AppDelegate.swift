import UIKit
import UserNotifications

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
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
        UNUserNotificationCenter.current().delegate = self
        pushManager.start()
        application.registerForRemoteNotifications()
        callCoordinator.prepareMicrophonePermission()
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

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}
