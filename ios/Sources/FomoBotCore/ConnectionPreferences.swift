import Foundation

/// Only the endpoint goes into ordinary preferences. Credentials are always a
/// separate CredentialStore operation and are never accepted by this type.
@MainActor public final class ConnectionPreferences {
    private let defaults: UserDefaults
    private let key = "fomobot.controller.endpoint.v1"
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public func load() throws -> BackendEndpoint? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try JSONDecoder().decode(BackendEndpoint.self, from: data)
    }
    public func save(_ endpoint: BackendEndpoint) throws { defaults.set(try JSONEncoder().encode(endpoint), forKey: key) }
    public func remove() { defaults.removeObject(forKey: key) }
}
