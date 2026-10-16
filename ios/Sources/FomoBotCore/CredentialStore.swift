import Foundation
#if canImport(Security)
import Security
#endif

public enum CredentialError: Error, Sendable { case missing, unavailable, accessDenied, invalid }
public protocol CredentialStore: Sendable {
    func token(for endpoint: BackendEndpoint) async throws -> String
    func save(_ token: String, for endpoint: BackendEndpoint) async throws
    func remove(for endpoint: BackendEndpoint) async throws
}
/// Device-only, unlocked Keychain entries. There is no plaintext fallback.
public actor KeychainCredentialStore: CredentialStore {
    public init() {}
    #if canImport(Security)
    private func query(_ endpoint: BackendEndpoint) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.fomobot.controller", kSecAttrAccount as String: endpoint.identity, kSecAttrSynchronizable as String: false]
    }
    public func token(for endpoint: BackendEndpoint) throws -> String {
        var q = query(endpoint); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
        guard status != errSecItemNotFound else { throw CredentialError.missing }
        guard status == errSecSuccess, let bytes = result as? Data, let value = String(data: bytes, encoding: .utf8), validAccessToken(value) else { throw CredentialError.accessDenied }
        return value
    }
    public func save(_ token: String, for endpoint: BackendEndpoint) throws {
        guard validAccessToken(token) else { throw CredentialError.invalid }
        let q = query(endpoint), update: [String: Any] = [kSecValueData as String: Data(token.utf8), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(q as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var item = q; update.forEach { item[$0.key] = $0.value }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw CredentialError.accessDenied }
        } else if status != errSecSuccess { throw CredentialError.accessDenied }
    }
    public func remove(for endpoint: BackendEndpoint) throws {
        let status = SecItemDelete(query(endpoint) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CredentialError.accessDenied }
    }
    #else
    public func token(for endpoint: BackendEndpoint) throws -> String { throw CredentialError.unavailable }
    public func save(_ token: String, for endpoint: BackendEndpoint) throws { throw CredentialError.unavailable }
    public func remove(for endpoint: BackendEndpoint) throws { throw CredentialError.unavailable }
    #endif
}
