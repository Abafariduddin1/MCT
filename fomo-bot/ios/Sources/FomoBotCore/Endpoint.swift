import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct BackendEndpoint: Codable, Hashable, Sendable {
    public let identity: String
    public let allowsInsecureLoopback: Bool
    public init(_ address: String, allowInsecureLoopback: Bool = false) throws {
        guard address.count <= 2000, let parts = URLComponents(string: address),
              let scheme = parts.scheme?.lowercased(), ["https", "wss", "http", "ws"].contains(scheme),
              let host = parts.host?.lowercased(), !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, ["", "/", "/stream"].contains(parts.percentEncodedPath),
              parts.port == nil || (1...65535).contains(parts.port!) else { throw ModelError.invalidEndpoint }
        let insecure = scheme == "http" || scheme == "ws", loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard !insecure || allowInsecureLoopback && loopback else { throw ModelError.invalidEndpoint }
        var normalized = parts; normalized.scheme = insecure ? "http" : "https"; normalized.host = host; normalized.path = "/"
        guard let string = normalized.string else { throw ModelError.invalidEndpoint }
        identity = string; allowsInsecureLoopback = allowInsecureLoopback
    }
    private enum Keys: String, CodingKey { case identity, allowsInsecureLoopback }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        try self.init(c.decode(String.self, forKey: .identity), allowInsecureLoopback: c.decode(Bool.self, forKey: .allowsInsecureLoopback))
    }
    public var socketURL: URL { var p = URLComponents(string: identity)!; p.scheme = p.scheme == "http" ? "ws" : "wss"; p.path = "/stream"; return p.url! }
    public func commandStatusURL(id: String) throws -> URL {
        guard (16...80).contains(id.count), id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { throw ModelError.invalidCommand }
        return URL(string: identity)!.appendingPathComponent("v1/commands/" + id)
    }
    public func authenticatedRequest(url: URL, token: String) throws -> URLRequest {
        guard validAccessToken(token), let base = URLComponents(string: identity), let target = URLComponents(url: url, resolvingAgainstBaseURL: false),
              target.host == base.host, target.port == base.port, [base.scheme, base.scheme == "https" ? "wss" : "ws"].contains(target.scheme),
              target.user == nil, target.password == nil, target.query == nil, target.fragment == nil else { throw ModelError.invalidEndpoint }
        var request = URLRequest(url: url); request.timeoutInterval = 10; request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization"); request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }
}
public func validAccessToken(_ token: String) -> Bool {
    (43...128).contains(token.count) && Set(token).count >= 16 && token.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
}
public enum AvatarRequest {
    private static let hosts = Set(["cdn.dexscreener.com", "dd.dexscreener.com", "ipfs.io", "gateway.pinata.cloud", "pump.mypinata.cloud", "arweave.net"])
    /// A separate request: never reuse the controller Authorization header for images.
    public static func make(_ value: String?) -> URLRequest? {
        guard let value, value.count <= 1500, let parts = URLComponents(string: value), parts.scheme == "https", let host = parts.host,
              hosts.contains(host), parts.user == nil, parts.password == nil, let url = parts.url else { return nil }
        return URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 10)
    }
}
