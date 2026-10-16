import Foundation

public enum DeliveryState: String, Codable, Sendable { case prepared, sent, unknown, acknowledged }
public struct LocalCommand: Codable, Equatable, Sendable, Identifiable {
    public var id: String { envelope.id }
    public let envelope: CommandEnvelope; public let endpointIdentity: String; public let wallet: String; public let mode: TradingMode; public let createdAt: Date
    public var delivery: DeliveryState; public var remote: CommandRecord?; public var reviewReason: String?
    public var isUnresolved: Bool { remote.map { !$0.stage.isTerminal } ?? true }
    public init(envelope: CommandEnvelope, endpoint: BackendEndpoint, wallet: String, mode: TradingMode, at: Date = .now) {
        self.envelope = envelope; endpointIdentity = endpoint.identity; self.wallet = wallet; self.mode = mode; createdAt = at; delivery = .prepared; remote = nil; reviewReason = nil
    }
    public func merging(_ newer: LocalCommand) throws -> LocalCommand {
        guard id == newer.id, envelope == newer.envelope, endpointIdentity == newer.endpointIdentity, wallet == newer.wallet, mode == newer.mode else { throw ModelError.corruptJournal }
        var value = newer
        if let original = remote {
            if let incoming = newer.remote, original.hash != incoming.hash { throw ModelError.corruptJournal }
            if newer.remote == nil || original.stage.isTerminal || original.stage.progress > (newer.remote?.stage.progress ?? -1) {
                value.remote = original; value.delivery = .acknowledged
            }
        }
        return value
    }
}
public protocol CommandStore: Sendable {
    func load() async throws -> [LocalCommand]
    func upsert(_ command: LocalCommand) async throws
}
public actor FileCommandStore: CommandStore {
    private let file: URL
    private struct Saved: Codable { let version: Int; var commands: [LocalCommand] }
    public init(file: URL) { self.file = file }
    public func load() throws -> [LocalCommand] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        guard (try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 4_000_000 else { throw ModelError.corruptJournal }
        let saved = try JSONDecoder().decode(Saved.self, from: Data(contentsOf: file))
        guard saved.version == 1, saved.commands.count <= 1000, Set(saved.commands.map(\.id)).count == saved.commands.count else { throw ModelError.corruptJournal }
        for c in saved.commands {
            let endpoint = try BackendEndpoint(c.endpointIdentity, allowInsecureLoopback: true)
            guard c.endpointIdentity == endpoint.identity, c.remote == nil || c.remote?.id == c.id else { throw ModelError.corruptJournal }
        }
        return saved.commands
    }
    public func upsert(_ command: LocalCommand) throws {
        var rows = try load()
        if let i = rows.firstIndex(where: { $0.id == command.id }) {
            guard rows[i].envelope == command.envelope, rows[i].endpointIdentity == command.endpointIdentity, rows[i].mode == command.mode, rows[i].wallet == command.wallet else { throw ModelError.corruptJournal }
            rows[i] = try rows[i].merging(command)
        } else { guard rows.count < 1000 else { throw ModelError.journalFull }; rows.append(command) }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let bytes = try JSONEncoder().encode(Saved(version: 1, commands: rows))
        #if os(iOS)
        try bytes.write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try bytes.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
