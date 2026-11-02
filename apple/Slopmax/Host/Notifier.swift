// Notices from the daemon as macOS notifications. The daemon decides what
// is worth telling and tells each once; the app only posts it.
import Foundation
import SlopmaxKit
import UserNotifications

enum Notifier {
    static func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    static func post(_ notice: Notice) {
        let content = UNMutableNotificationContent()
        content.title = notice.provider.map { "slopmax · \($0.title)" } ?? "slopmax"
        content.body = notice.message
        let request = UNNotificationRequest(identifier: notice.key, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
