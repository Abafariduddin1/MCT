import Foundation
import Observation

public enum ConnectionSetupError: Error, Equatable { case separateEndpointsRequired }

@MainActor @Observable public final class TradingAppModel {
    public let client: BotWebSocketClient
    public private(set) var section: TradingSection = .paper
    public private(set) var mode: TradingMode = .paper
    public var needsConnection = false
    public var notice: String?
    public var setupError: String?
    public private(set) var displayTime = Date.now
    @ObservationIgnored private let credentials: any CredentialStore
    @ObservationIgnored private let profiles: TradingProfiles
    @ObservationIgnored private var revision = 0

    public init(credentials: any CredentialStore = KeychainCredentialStore(), journal: any CommandStore, profiles: TradingProfiles = TradingProfiles(), transport: any ControllerTransport = URLSessionControllerTransport()) {
        self.credentials = credentials; self.profiles = profiles
        client = BotWebSocketClient(credentials: credentials, journal: journal, transport: transport)
    }
    public static func production() -> TradingAppModel {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("FomoBot", isDirectory: true)
        return TradingAppModel(journal: FileCommandStore(file: directory.appendingPathComponent("commands-v1.json")))
    }
    public var portfolio: PortfolioSnapshot? { client.portfolio?.mode == mode ? client.portfolio : nil }
    public var isReady: Bool { client.isFresh && portfolio != nil && client.lastPortfolioReceived.map { displayTime.timeIntervalSince($0) < 10 } == true }
    public var serverNow: Int64 { Int64((displayTime.timeIntervalSince1970 + client.serverClockOffset) * 1000) }
    public func refreshClock(at time: Date = .now) { displayTime = time }
    public var activeCommands: [LocalCommand] {
        guard let p = portfolio, let endpoint = client.endpointIdentity else { return [] }
        return client.commands.filter { $0.endpointIdentity == endpoint && ($0.wallet == p.wallet && $0.mode == p.mode || $0.isUnresolved) }.sorted { $0.createdAt > $1.createdAt }
    }
    public func endpointText(for mode: TradingMode) -> String { (try? profiles.endpoint(for: mode))?.identity ?? "" }
    public func start() async { await connectConfigured() }
    public func select(_ section: TradingSection) async {
        self.section = section
        if section != .copy { await selectMode(section == .live ? .live : .paper) }
    }
    public func selectMode(_ target: TradingMode) async {
        if section != .copy { section = target == .paper ? .paper : .live }
        if mode == target && client.connectionState != .disconnected { return }
        mode = target; notice = nil; setupError = nil; needsConnection = false
        await connectConfigured()
    }
    public func connectConfigured() async {
        revision += 1; let ownRevision = revision; let selected = mode
        await client.disconnect()
        guard revision == ownRevision else { return }
        do {
            guard let endpoint = try profiles.endpoint(for: selected) else { needsConnection = true; return }
            await client.connect(to: endpoint, expectedMode: selected)
        } catch { setupError = "The saved connection needs review. Edit this profile to continue."; needsConnection = true }
    }
    public func saveConnection(address: String, token: String, for target: TradingMode) async throws {
        let endpoint = try BackendEndpoint(address.trimmingCharacters(in: .whitespacesAndNewlines))
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard validAccessToken(token) else { throw ModelError.invalidToken }
        let other: TradingMode = target == .paper ? .live : .paper
        if try profiles.endpoint(for: other)?.identity == endpoint.identity { throw ConnectionSetupError.separateEndpointsRequired }
        try await credentials.save(token, for: endpoint)
        try profiles.save(endpoint, for: target)
        setupError = nil; needsConnection = false
        if target == mode { await connectConfigured() }
    }
    public func disconnect() async { revision += 1; await client.disconnect() }
    public func setForeground(_ active: Bool) async { await client.setForeground(active) }
    public func buy(_ token: FeedToken, amount: SolAmount) async {
        if let reason = BuySizing.blockReason(token: token, portfolio: portfolio, isFresh: isReady, now: serverNow) { notice = reason; return }
        await send(.buy(mint: token.mint, amount: amount))
    }
    public func sell(_ position: Position, bps: Int) async { await send(.sell(mint: position.mint, percentBps: bps)) }
    public func updateSettings(preset: BotPreset? = nil, autoPilot: Bool? = nil, normal: Bool? = nil, copy: Bool? = nil, amount: SolAmount? = nil) async {
        guard let p = portfolio, let current = try? SolAmount(p.settings.orderLamports.formatted(maximumFractionDigits: 9)) else { return }
        await send(.preset(preset ?? p.settings.preset, autoPilot: autoPilot ?? p.settings.autoPilot,
                           normalEnabled: normal ?? p.settings.normalEnabled, copyEnabled: copy ?? p.settings.copyEnabled, amount: amount ?? current))
    }
    public func send(_ payload: CommandPayload) async {
        guard isReady else { notice = "Waiting for a fresh connection."; return }
        do { let id = try await client.send(payload); notice = "Request saved · " + String(id.prefix(8)) }
        catch ClientError.pendingFinancialAction { notice = "Wait for the existing trade to resolve." }
        catch ClientError.persistenceFailed { notice = "Command history could not be saved. The action was blocked." }
        catch { notice = "The action needs review. Its original ID is retained in Activity." }
    }
}
