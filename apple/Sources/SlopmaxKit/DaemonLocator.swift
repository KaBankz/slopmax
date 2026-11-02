// Finding the daemon: the bundled CLI says where it listens and its key
// (`slopmax daemon-info --json`), and whether one answers there and which.
import Foundation

public struct DaemonInfo: Codable, Sendable, Equatable {
    public var base: URL
    public var key: String
    /// The bundled CLI's version.
    public var version: String
    public var exe: String?
    public var home: String
    public var running: Bool
    public var runningVersion: String?

    public var daemon: Daemon { Daemon(base: base, key: key) }

    /// A daemon answers, but another version than the one bundled: the app
    /// restarts it only when it is its own (`managed`).
    public var otherVersion: Bool { running && runningVersion != version }
}

public enum DaemonLocator {
    /// Runs `cli daemon-info --json` and reads what it says.
    public static func locate(cli: URL) throws -> DaemonInfo {
        let process = Process()
        process.executableURL = cli
        process.arguments = ["daemon-info", "--json"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return try JSONDecoder().decode(DaemonInfo.self, from: data)
    }

    /// Whether the daemon a `Hello` describes is the one `cli` would run,
    /// so the app may restart it after an update.
    public static func manages(exe: String?, cli: URL) -> Bool {
        guard let exe else { return false }
        return URL(fileURLWithPath: exe).standardizedFileURL.path == cli.standardizedFileURL.path
    }
}
