import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum TransportError: Error, Equatable, Sendable { case unauthorized, unavailable, invalidResponse, redirected, notFound }
public protocol SocketConnection: Sendable {
    func receive() async throws -> Data
    func send(_ data: Data) async throws
    func ping() async throws
    func close() async
}
public enum CommandLookup: Sendable { case found(CommandRecord), notFound }
public protocol ControllerTransport: Sendable {
    func open(endpoint: BackendEndpoint, token: String) async throws -> any SocketConnection
    func lookup(id: String, endpoint: BackendEndpoint, token: String) async throws -> CommandLookup
}
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
public final class URLSessionControllerTransport: ControllerTransport, Sendable {
    private let session: URLSession
    public init() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCache = nil
        config.timeoutIntervalForRequest = 10; config.timeoutIntervalForResource = 30
        session = URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }
    public func open(endpoint: BackendEndpoint, token: String) throws -> any SocketConnection {
        let request = try endpoint.authenticatedRequest(url: endpoint.socketURL, token: token)
        let task = session.webSocketTask(with: request); task.maximumMessageSize = 1_000_000; task.resume()
        return NativeSocket(task: task)
    }
    public func lookup(id: String, endpoint: BackendEndpoint, token: String) async throws -> CommandLookup {
        let request = try endpoint.authenticatedRequest(url: endpoint.commandStatusURL(id: id), token: token)
        let (bytes, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, bytes.count <= 1_000_000 else { throw TransportError.invalidResponse }
        if response.statusCode == 401 || response.statusCode == 403 { throw TransportError.unauthorized }
        if response.statusCode == 404 { return .notFound }
        guard response.statusCode == 200, response.url == request.url else { throw TransportError.invalidResponse }
        guard case .command(let envelope) = try ServerMessage.decode(bytes), envelope.data.id == id else { throw TransportError.invalidResponse }
        return .found(envelope.data)
    }
}
private actor NativeSocket: SocketConnection {
    private let task: URLSessionWebSocketTask
    init(task: URLSessionWebSocketTask) { self.task = task }
    func receive() async throws -> Data {
        do {
            switch try await task.receive() {
            case .string(let text): guard let bytes = text.data(using: .utf8), bytes.count <= 1_000_000 else { throw ModelError.oversizedFrame }; return bytes
            case .data: throw ModelError.malformedFrame // Protocol v1 uses text JSON frames.
            @unknown default: throw ModelError.malformedFrame
            }
        } catch {
            if let response = task.response as? HTTPURLResponse, [401, 403].contains(response.statusCode) { throw TransportError.unauthorized }
            throw error
        }
    }
    func send(_ data: Data) async throws {
        guard data.count <= 16384, let text = String(data: data, encoding: .utf8) else { throw ModelError.oversizedFrame }
        try await task.send(.string(text))
    }
    func ping() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            task.sendPing { error in if let error { continuation.resume(throwing: error) } else { continuation.resume() } }
        }
    }
    func close() { task.cancel(with: .goingAway, reason: nil) }
}
