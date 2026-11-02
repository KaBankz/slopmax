// Following the daemon's event stream: a reader for server-sent events, and
// a stream that reconnects when the daemon restarts or goes away, so the
// app never polls.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Splits server-sent events out of the bytes as they arrive: each event's
/// `data:` lines joined, ready to decode. Comments and other fields are
/// passed over. Pure, so it is tested on bytes alone.
public struct SSEReader: Sendable {
    private var buffer = Data()
    private var data: [String] = []

    public init() {}

    /// Every event `chunk` completes, in order.
    public mutating func feed(_ chunk: Data) -> [String] {
        buffer.append(chunk)
        var events: [String] = []
        while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            var line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            if line.last == UInt8(ascii: "\r") { line = line.dropLast() }
            if line.isEmpty {
                if !data.isEmpty {
                    events.append(data.joined(separator: "\n"))
                    data.removeAll()
                }
                continue
            }
            let text = String(decoding: line, as: UTF8.self)
            if text.hasPrefix("data:") {
                var value = text.dropFirst(5)
                if value.first == " " { value = value.dropFirst() }
                data.append(String(value))
            }
        }
        return events
    }
}

/// What following the stream brings.
public enum Followed: Sendable, Equatable {
    case event(Event)
    /// The connection dropped; the next try is in this many seconds.
    case disconnected(retryIn: Double)
}

/// Follows `/events`, reconnecting after a drop: in a second at first, then
/// backing off to 15 seconds while the daemon stays away.
public final class EventStream: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let daemon: Daemon
    private let lock = NSLock()
    private var reader = SSEReader()
    private var continuation: AsyncStream<Followed>.Continuation?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var backoff: Double = 1
    private var stopped = false

    public init(_ daemon: Daemon) {
        self.daemon = daemon
    }

    /// The events, until the stream is stopped.
    public func follow() -> AsyncStream<Followed> {
        AsyncStream { continuation in
            lock.withLock { self.continuation = continuation }
            continuation.onTermination = { [weak self] _ in self?.stop() }
            connect()
        }
    }

    public func stop() {
        lock.withLock {
            stopped = true
            task?.cancel()
            session?.invalidateAndCancel()
        }
    }

    private func connect() {
        lock.withLock {
            guard !stopped else { return }
            reader = SSEReader()
            var request = URLRequest(url: daemon.url("/events"))
            request.setValue("Bearer \(daemon.key)", forHTTPHeaderField: "Authorization")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            // The daemon pings every 15 seconds, so a minute of silence
            // means the connection is gone; a stream may last a week.
            request.timeoutInterval = 60
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 60
            configuration.timeoutIntervalForResource = 60 * 60 * 24 * 7
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            self.session = session
            task = session.dataTask(with: request)
            task?.resume()
        }
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let decoder = Wire.decoder()
        let events = lock.withLock { reader.feed(data) }
        for payload in events {
            guard let event = try? decoder.decode(Event.self, from: Data(payload.utf8)) else { continue }
            if case .hello = event { lock.withLock { backoff = 1 } }
            _ = lock.withLock { continuation }?.yield(.event(event))
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let (wait, continuation, stopped) = lock.withLock { () -> (Double, AsyncStream<Followed>.Continuation?, Bool) in
            let wait = backoff
            backoff = min(backoff * 2, 15)
            return (wait, self.continuation, self.stopped)
        }
        session.finishTasksAndInvalidate()
        guard !stopped else { return }
        continuation?.yield(.disconnected(retryIn: wait))
        DispatchQueue.global().asyncAfter(deadline: .now() + wait) { [weak self] in self?.connect() }
    }
}
