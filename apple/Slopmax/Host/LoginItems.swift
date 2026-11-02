// Starting at login: the daemon as a launch agent from the bundle (Login
// Items shows it under the app's name and icon), and the app itself, which
// posts the notifications.
import Foundation
import ServiceManagement

enum LoginItems {
    static let daemon = SMAppService.agent(plistName: "dev.slopmax.agent.plist")

    /// Registers the daemon's agent if it is not yet; macOS may ask the user
    /// to approve it in System Settings first.
    static func registerDaemon() {
        switch daemon.status {
        case .enabled: return
        case .requiresApproval: SMAppService.openSystemSettingsLoginItems()
        default: try? daemon.register()
        }
    }

    static var appOpensAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            if newValue { try? SMAppService.mainApp.register() } else { try? SMAppService.mainApp.unregister() }
        }
    }
}
