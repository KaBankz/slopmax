// The event stream: the report whenever it changes, each request as it is
// answered, and sign-in progress. The app follows it instead of polling.
import Foundation

public enum Event: Codable, Sendable, Equatable {
    case hello(version: String, exe: String?)
    case status(Report)
    case request(RequestRecord)
    case notice(Notice)
    case login(id: String, event: LoginEvent)
    case ping

    private enum Keys: String, CodingKey { case version, exe, report, record, notice, id, event }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: Keys.self)
        switch try decoder.tag() {
        case "Hello":
            self = .hello(
                version: try fields.decode(String.self, forKey: .version),
                exe: try fields.decodeIfPresent(String.self, forKey: .exe))
        case "Status": self = .status(try fields.decode(Report.self, forKey: .report))
        case "Request":
            guard case .request(let record) = try fields.decode(LedgerRecord.self, forKey: .record) else {
                throw UnknownTag(tag: "?", union: "LedgerRecord")
            }
            self = .request(record)
        case "Notice": self = .notice(try fields.decode(Notice.self, forKey: .notice))
        case "Login":
            self = .login(
                id: try fields.decode(String.self, forKey: .id),
                event: try fields.decode(LoginEvent.self, forKey: .event))
        case "Ping": self = .ping
        case let other: throw UnknownTag(tag: other, union: "Event")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: Keys.self)
        switch self {
        case .hello(let version, let exe):
            try encoder.tag("Hello")
            try fields.encode(version, forKey: .version)
            try fields.encodeIfPresent(exe, forKey: .exe)
        case .status(let report):
            try encoder.tag("Status")
            try fields.encode(report, forKey: .report)
        case .request(let record):
            try encoder.tag("Request")
            try fields.encode(LedgerRecord.request(record), forKey: .record)
        case .notice(let notice):
            try encoder.tag("Notice")
            try fields.encode(notice, forKey: .notice)
        case .login(let id, let event):
            try encoder.tag("Login")
            try fields.encode(id, forKey: .id)
            try fields.encode(event, forKey: .event)
        case .ping: try encoder.tag("Ping")
        }
    }
}

/// How a sign-in started from the app is going.
public enum LoginEvent: Codable, Sendable, Equatable {
    case authorize(title: String, url: URL, port: Int, opened: Bool)
    case deviceCode(url: URL, code: String)
    case note(String)
    case done(account: AccountView, isNew: Bool)
    case failed(String)

    private enum Keys: String, CodingKey { case title, url, port, opened, code, text, account, isNew, message }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: Keys.self)
        switch try decoder.tag() {
        case "Authorize":
            self = .authorize(
                title: try fields.decode(String.self, forKey: .title),
                url: try fields.decode(URL.self, forKey: .url),
                port: try fields.decode(Int.self, forKey: .port),
                opened: try fields.decode(Bool.self, forKey: .opened))
        case "DeviceCode":
            self = .deviceCode(
                url: try fields.decode(URL.self, forKey: .url),
                code: try fields.decode(String.self, forKey: .code))
        case "Note": self = .note(try fields.decode(String.self, forKey: .text))
        case "Done":
            self = .done(
                account: try fields.decode(AccountView.self, forKey: .account),
                isNew: try fields.decode(Bool.self, forKey: .isNew))
        case "Failed": self = .failed(try fields.decode(String.self, forKey: .message))
        case let other: throw UnknownTag(tag: other, union: "LoginEvent")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: Keys.self)
        switch self {
        case .authorize(let title, let url, let port, let opened):
            try encoder.tag("Authorize")
            try fields.encode(title, forKey: .title)
            try fields.encode(url, forKey: .url)
            try fields.encode(port, forKey: .port)
            try fields.encode(opened, forKey: .opened)
        case .deviceCode(let url, let code):
            try encoder.tag("DeviceCode")
            try fields.encode(url, forKey: .url)
            try fields.encode(code, forKey: .code)
        case .note(let text):
            try encoder.tag("Note")
            try fields.encode(text, forKey: .text)
        case .done(let account, let isNew):
            try encoder.tag("Done")
            try fields.encode(account, forKey: .account)
            try fields.encode(isNew, forKey: .isNew)
        case .failed(let message):
            try encoder.tag("Failed")
            try fields.encode(message, forKey: .message)
        }
    }
}
