import Foundation
import Observation

public enum ConnectionState: Equatable, Sendable {
    case disconnected, connecting, synchronizing, ready, reconnecting(attempt: Int), suspended, blocked(String)
    public var label: String {
        switch self {
        case .disconnected: "Disconnected"
        case .connecting: "Connecting"
        case .synchronizing: "Refreshing state"
        case .ready: "Connected"
        case .reconnecting: "Reconnecting"
        case .suspended: "App in background"
        case .blocked(let reason): reason
        }
    }
}
public enum ClientError: Error, Equatable, Sendable { case notReady, pendingFinancialAction, missingCredential, persistenceFailed, staleState, walletChanged, modeMismatch }

/// UI state is main-actor isolated. The journal is saved before any mutation is
/// sent. Reconnect performs reads only; it never resends a trading command.
@MainActor @Observable public final class BotWebSocketClient {
    public private(set) var connectionState: ConnectionState = .disconnected
    public private(set) var portfolio: PortfolioSnapshot?
    public private(set) var feed: [FeedToken] = []
    public private(set) var charts: [MintAddress: ChartHistory] = [:]
    public private(set) var commands: [LocalCommand] = []
    public private(set) var tradeAlerts: [TradeAlert] = []
    public private(set) var performance: StrategyReport?
    public private(set) var lastError: String?
    public private(set) var lastPortfolioReceived: Date?
    public private(set) var lastFeedReceived: Date?
    public private(set) var serverClockOffset: TimeInterval = 0
    @ObservationIgnored private let credentials: any CredentialStore
    @ObservationIgnored private let journal: any CommandStore
    @ObservationIgnored private let transport: any ControllerTransport
    @ObservationIgnored private var endpoint: BackendEndpoint?
    @ObservationIgnored private var socket: (any SocketConnection)?
    @ObservationIgnored private var receiveTask: Task<Void, Never>?
    @ObservationIgnored private var heartbeatTask: Task<Void, Never>?
    @ObservationIgnored private var pingTask: Task<Void, Never>?
    @ObservationIgnored private var pingStarted: Date?
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var lookupTask: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var wantsConnection = false
    @ObservationIgnored private var foreground = true
    @ObservationIgnored private var retryCount = 0
    @ObservationIgnored private var lastSequence: Int64 = 0
    @ObservationIgnored private var lastMessage: Date?
    @ObservationIgnored private var hasPortfolio = false
    @ObservationIgnored private var hasFeed = false
    @ObservationIgnored private var seenAlerts = Set<String>()
    @ObservationIgnored private var sending = false
    @ObservationIgnored private var resolving = false
    @ObservationIgnored private var lookupCursor = 0
    @ObservationIgnored private var persistenceBlocked = false
    @ObservationIgnored private var expectedMode: TradingMode?
    public init(credentials: any CredentialStore = KeychainCredentialStore(), journal: any CommandStore, transport: any ControllerTransport = URLSessionControllerTransport()) {
        self.credentials = credentials; self.journal = journal; self.transport = transport
    }
    public var isFresh: Bool { !persistenceBlocked && connectionState == .ready && lastPortfolioReceived.map { Date.now.timeIntervalSince($0) < 10 } == true }
    public var hasPendingFinancialAction: Bool {
        guard let endpoint else { return false }
        return commands.contains { $0.endpointIdentity == endpoint.identity && $0.envelope.payload.isFinancial && $0.isUnresolved } || portfolio?.pending.isEmpty == false
    }
    public var endpointIdentity: String? { endpoint?.identity }
    public func connect(to endpoint: BackendEndpoint, expectedMode: TradingMode? = nil) async {
        let requestGeneration = generation + 1
        await disconnect(); guard generation == requestGeneration else { return }
        self.endpoint = endpoint; self.expectedMode = expectedMode; wantsConnection = true; persistenceBlocked = false
        do { let loaded = try await journal.load(); guard generation == requestGeneration else { return }; commands = loaded }
        catch { connectionState = .blocked("Saved command history needs review"); lastError = "Command history could not be read safely."; return }
        await establish()
    }
    public func disconnect() async {
        wantsConnection = false; generation += 1; receiveTask?.cancel(); heartbeatTask?.cancel(); pingTask?.cancel(); retryTask?.cancel(); lookupTask?.cancel(); pingStarted = nil
        let old = socket; socket = nil; connectionState = .disconnected; hasPortfolio = false; hasFeed = false
        portfolio = nil; feed = []; charts = [:]; tradeAlerts = []; performance = nil
        lastPortfolioReceived = nil; lastFeedReceived = nil; lastError = nil; serverClockOffset = 0
        await old?.close()
    }
    public func setForeground(_ active: Bool) async {
        foreground = active
        if !active {
            generation += 1; receiveTask?.cancel(); heartbeatTask?.cancel(); pingTask?.cancel(); retryTask?.cancel(); lookupTask?.cancel(); pingStarted = nil
            let old = socket; socket = nil; connectionState = .suspended; hasPortfolio = false; hasFeed = false; await old?.close()
        } else if wantsConnection { await establish() }
    }
    private func establish() async {
        guard wantsConnection, foreground, let endpoint else { return }
        generation += 1; let ownGeneration = generation; hasPortfolio = false; hasFeed = false; lastSequence = 0
        connectionState = retryCount == 0 ? .connecting : .reconnecting(attempt: retryCount)
        do {
            let token = try await credentials.token(for: endpoint)
            guard validAccessToken(token), generation == ownGeneration else { throw CredentialError.invalid }
            let connection = try await transport.open(endpoint: endpoint, token: token)
            guard generation == ownGeneration, wantsConnection, foreground else { await connection.close(); return }
            socket = connection; lastMessage = .now; connectionState = .synchronizing
            receiveTask = Task { [weak self] in
                do {
                    while !Task.isCancelled {
                        let bytes = try await connection.receive()
                        guard let self, self.generation == ownGeneration else { return }
                        try await self.accept(bytes)
                    }
                } catch { await self?.connectionFailed(error, generation: ownGeneration) }
            }
            heartbeatTask = Task { [weak self] in
                var lastPing = Date.now, lastLookup = Date.now
                do {
                    while !Task.isCancelled {
                        try await Task.sleep(for: .seconds(2))
                        guard let self, self.generation == ownGeneration else { return }
                        let age = Date.now.timeIntervalSince(self.lastMessage ?? .distantPast)
                        if age > (self.hasPortfolio && self.hasFeed ? 45 : 10) { throw TransportError.unavailable }
                        if let started = self.pingStarted, Date.now.timeIntervalSince(started) > 8 { throw TransportError.unavailable }
                        if self.pingStarted == nil && Date.now.timeIntervalSince(lastPing) >= 20 {
                            lastPing = .now; self.pingStarted = .now
                            self.pingTask = Task { [weak self] in
                                do { try await connection.ping(); if self?.generation == ownGeneration { self?.pingStarted = nil } }
                                catch { await self?.connectionFailed(error, generation: ownGeneration) }
                            }
                        }
                        if Date.now.timeIntervalSince(lastLookup) >= 30 {
                            lastLookup = .now
                            self.lookupTask = Task { [weak self] in await self?.resolvePendingCommands() }
                        }
                    }
                } catch { if !Task.isCancelled { await self?.connectionFailed(error, generation: ownGeneration) } }
            }
            try await sendRead(.snapshot)
        } catch { await connectionFailed(error, generation: ownGeneration) }
    }
    private func connectionFailed(_ error: any Error, generation failedGeneration: Int) async {
        guard generation == failedGeneration else { return }
        generation += 1; receiveTask?.cancel(); heartbeatTask?.cancel(); pingTask?.cancel(); lookupTask?.cancel(); pingStarted = nil
        let transitionGeneration = generation
        let old = socket; socket = nil; await old?.close(); guard generation == transitionGeneration else { return }; hasPortfolio = false; hasFeed = false
        // Never log an error containing a URLRequest, token or backend URL.
        if error is CredentialError || error as? TransportError == .unauthorized {
            connectionState = .blocked("Check the controller credential"); lastError = "Authentication failed."; return
        }
        if error as? ClientError == .modeMismatch || error as? ClientError == .walletChanged {
            connectionState = .blocked("The backend does not match this trading profile")
            lastError = "Check the selected Paper or Real connection. No command was sent."; return
        }
        if error as? ClientError == .persistenceFailed {
            connectionState = .blocked("Saved command history needs review"); lastError = "Command status could not be saved safely."; return
        }
        if error is DecodingError || error as? ModelError == .unsupportedProtocol || error as? ModelError == .malformedFrame || error as? ModelError == .oversizedFrame {
            connectionState = .blocked("Backend data needs a compatible client"); lastError = "Protocol validation failed."; return
        }
        guard wantsConnection, foreground else { connectionState = foreground ? .disconnected : .suspended; return }
        retryCount += 1; connectionState = .reconnecting(attempt: retryCount); lastError = "Connection interrupted. Pending actions will be checked by their original IDs."
        let delay = min(30.0, pow(2.0, Double(min(retryCount - 1, 5)))) * Double.random(in: 0.8...1.2)
        let retryGeneration = generation
        retryTask?.cancel(); retryTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, self.generation == retryGeneration else { return }; await self.establish()
        }
    }
    private func accept(_ bytes: Data) async throws {
        let ownGeneration = generation
        let message = try ServerMessage.decode(bytes)
        guard message.sequence > lastSequence else { return }
        lastSequence = message.sequence; lastMessage = .now
        switch message {
        case .portfolio(let e):
            if let expectedMode, e.data.mode != expectedMode { throw ClientError.modeMismatch }
            if hasPortfolio, let old = portfolio, old.wallet != e.data.wallet || old.mode != e.data.mode { throw ClientError.walletChanged }
            portfolio = e.data; hasPortfolio = true; lastPortfolioReceived = .now; serverClockOffset = Double(e.at) / 1000 - Date.now.timeIntervalSince1970
            for remote in e.data.recentCommands { try await apply(remote); if generation != ownGeneration { return } }
        case .feed(let e): feed = e.data.tokens; hasFeed = true; lastFeedReceived = .now
        case .chart(let e):
            if charts.count >= 40 && charts[e.data.mint] == nil, let oldest = charts.keys.sorted(by: { $0.description < $1.description }).first { charts.removeValue(forKey: oldest) }
            charts[e.data.mint] = e.data
        case .command(let e): try await apply(e.data)
        case .error: lastError = "The controller rejected a request. Check the original command status."
        case .alert(let e):
            guard let endpoint, let portfolio, e.data.mode == portfolio.mode else { break }
            // A fill notification must agree with the authoritative order just
            // received in the snapshot. ACKs and contradictory frames stay quiet.
            if e.data.type == "TRADE_FILLED" {
                guard e.data.isFill, let order = portfolio.recentOrders.first(where: { $0.id == e.data.data.orderId }),
                      order.applied, let recorded = order.receipt, let observed = e.data.data.receipt,
                      recorded.matchesFinancialEffects(of: observed),
                      recorded.confirmation == observed.confirmation || recorded.confirmation == "finalized",
                      order.signature == e.data.data.signature, order.mint == e.data.data.mint,
                      order.side == e.data.data.side else { break }
            }
            let key = endpoint.identity + "|" + portfolio.wallet + "|" + portfolio.mode.rawValue + "|" + String(e.data.seq)
            if seenAlerts.insert(key).inserted { tradeAlerts.append(e.data); tradeAlerts = Array(tradeAlerts.suffix(20)) }
            if seenAlerts.count > 2000 { seenAlerts = Set(tradeAlerts.map { endpoint.identity + "|" + portfolio.wallet + "|" + portfolio.mode.rawValue + "|" + String($0.seq) }) }
        case .performance(let e): performance = e.data
        case .unknown: break
        }
        guard generation == ownGeneration else { return }
        if hasPortfolio && hasFeed && !persistenceBlocked {
            let becameReady = connectionState != .ready; connectionState = .ready; retryCount = 0
            if becameReady {
                lookupTask?.cancel(); lookupTask = Task { [weak self] in await self?.resolvePendingCommands() }
            }
        }
    }
    private func apply(_ remote: CommandRecord) async throws {
        guard let endpoint, let portfolio, let index = commands.firstIndex(where: { $0.id == remote.id && $0.endpointIdentity == endpoint.identity }) else { return }
        let ownGeneration = generation; var item = commands[index]
        guard item.mode == portfolio.mode, item.wallet == portfolio.wallet, item.envelope.payload.wireType == remote.type else {
            item.reviewReason = "The backend wallet or mode changed; review this original action."; try await persist(item); if generation == ownGeneration { replace(item) }; return
        }
        item.remote = remote; item.delivery = .acknowledged; item.reviewReason = nil
        try await persist(item); if generation == ownGeneration { replace(item) }
    }
    @discardableResult public func send(_ payload: CommandPayload) async throws -> String {
        guard let endpoint, let portfolio, let socket, connectionState == .ready else { throw ClientError.notReady }
        guard isFresh else { throw ClientError.staleState }
        if let existing = commands.last(where: { $0.endpointIdentity == endpoint.identity && $0.mode == portfolio.mode && $0.wallet == portfolio.wallet && $0.envelope.payload == payload && $0.isUnresolved }) { return existing.id }
        guard !sending else { throw ClientError.pendingFinancialAction }
        if payload.isFinancial && hasPendingFinancialAction { throw ClientError.pendingFinancialAction }
        sending = true; defer { sending = false }
        let envelope = try CommandEnvelope(payload: payload); var item = LocalCommand(envelope: envelope, endpoint: endpoint, wallet: portfolio.wallet, mode: portfolio.mode)
        // Failure to save means no socket send. Saving before send can leave an
        // unsent command after a crash; it is investigated, never replayed.
        let ownGeneration = generation
        try await persist(item); commands.append(item)
        guard generation == ownGeneration, self.portfolio?.mode == portfolio.mode, self.portfolio?.wallet == portfolio.wallet, isFresh else {
            item.reviewReason = "Connection changed before this saved command was sent."; item.delivery = .unknown; try await persist(item); replace(item); throw ClientError.walletChanged
        }
        do {
            try await socket.send(envelope.data())
            if generation == ownGeneration, let i = commands.firstIndex(where: { $0.id == envelope.id }), commands[i].remote == nil {
                item.delivery = .sent; try await persist(item); if generation == ownGeneration { replace(item) }
            }
        } catch {
            if let i = commands.firstIndex(where: { $0.id == envelope.id }), commands[i].remote == nil {
                item.delivery = .unknown; item.reviewReason = "Delivery was interrupted. Check the original ID."
                do { try await persist(item); if generation == ownGeneration { replace(item) } }
                catch { await connectionFailed(ClientError.persistenceFailed, generation: ownGeneration); throw ClientError.persistenceFailed }
            }
            await connectionFailed(error, generation: ownGeneration)
        }
        return envelope.id
    }
    public func requestChart(_ mint: MintAddress) async throws { try await sendRead(.chart(mint)) }
    public func requestSnapshot() async throws { try await sendRead(.snapshot) }
    public func requestPerformance() async throws { try await sendRead(.performance) }
    private func sendRead(_ request: ReadRequest) async throws {
        guard let socket else { throw ClientError.notReady }
        try await socket.send(JSONEncoder().encode(request))
    }
    public func resolvePendingCommands() async {
        guard let endpoint, let portfolio, isFresh, !resolving else { return }
        resolving = true; defer { resolving = false }
        let ownGeneration = generation
        do {
            let token = try await credentials.token(for: endpoint)
            let pending = commands.filter({ $0.endpointIdentity == endpoint.identity && $0.isUnresolved })
            let rotated = pending.isEmpty ? [] : Array(pending.dropFirst(lookupCursor % pending.count)) + Array(pending.prefix(lookupCursor % pending.count))
            lookupCursor += min(20, rotated.count)
            for saved in rotated.prefix(20) {
                if Task.isCancelled || generation != ownGeneration { return }
                guard saved.mode == portfolio.mode, saved.wallet == portfolio.wallet else {
                    var item = saved; item.reviewReason = "Saved action belongs to a different wallet or mode."; try await persist(item); if generation == ownGeneration { replace(item) }; continue
                }
                let found = try await transport.lookup(id: saved.id, endpoint: endpoint, token: token)
                guard generation == ownGeneration else { return }
                switch found {
                case .found(let remote): try await apply(remote)
                case .notFound:
                    var item = saved; item.delivery = .unknown; item.reviewReason = "The backend has no record of this original ID. Review it before placing another trade."; try await persist(item); if generation == ownGeneration { replace(item) }
                }
            }
        } catch {
            if error as? ClientError == .persistenceFailed || error as? TransportError == .unauthorized { await connectionFailed(error, generation: ownGeneration) }
            else { lastError = "Pending actions could not be checked. Their original IDs are retained." }
        }
    }
    private func persist(_ item: LocalCommand) async throws {
        do { try await journal.upsert(item) } catch { throw ClientError.persistenceFailed }
    }
    private func replace(_ command: LocalCommand) {
        if let i = commands.firstIndex(where: { $0.id == command.id }) {
            do { commands[i] = try commands[i].merging(command) }
            catch { persistenceBlocked = true; connectionState = .blocked("Saved command identity needs review"); lastError = "The original command identity changed." }
        }
    }
}
