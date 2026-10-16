import Foundation

public enum TradingMode: String, Codable, Sendable { case paper, live }
public enum BotPreset: String, Codable, CaseIterable, Sendable { case safe = "Safe", fast = "Fast", degen = "Degen" }
public enum AllocationName: String, Codable, Sendable { case normal, copy, reserve }
public struct RemoteStage: Codable, Hashable, Sendable, RawRepresentable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    public var isTerminal: Bool { ["accepted", "finalized", "failed", "rejected"].contains(rawValue) }
    public var progress: Int {
        switch rawValue { case "received": 0; case "preparing": 1; case "prepared": 2; case "submitted": 3; case "unknown": 4; case "confirmed": 5; case "accepted", "finalized", "failed", "rejected": 6; default: -1 }
    }
    public var display: String {
        switch rawValue {
        case "received": "Received"
        case "accepted": "Updated"
        case "preparing": "Checking trade"
        case "prepared": "Prepared"
        case "submitted": "Submitted"
        case "unknown": "Outcome unknown"
        case "confirmed": "Confirmed · awaiting finality"
        case "finalized": "Finalized"
        case "failed": "Failed"
        case "rejected": "Rejected"
        default: "Status unavailable"
        }
    }
}
public struct ReferenceValue: Codable, Equatable, Sendable {
    public let solUsd: Double; public let usdcUsd: Double; public let solUsdc: Double; public let slot: Int64; public let at: Int64
}
public struct FxValue: Codable, Equatable, Sendable { public let eurUsd: Double; public let at: Int64; public let source: String }
public struct Allocation: Codable, Equatable, Sendable {
    public let pct: Int; public let cashLamports: RawAmount; public let dayStartLamports: RawAmount
    public let highWaterLamports: RawAmount; public let entries: Int; public let halt: String?
}
public struct AllocationSet: Codable, Equatable, Sendable { public let normal: Allocation; public let copy: Allocation; public let reserve: Allocation }
public struct AffordableAmounts: Codable, Equatable, Sendable { public let normal: RawAmount; public let copy: RawAmount }
public struct BotSettings: Codable, Equatable, Sendable {
    public let autoPilot: Bool; public let normalEnabled: Bool; public let copyEnabled: Bool; public let preset: BotPreset
    public let orderLamports: RawAmount; public let panic: Bool; public let paused: Bool
}
public struct Protection: Codable, Equatable, Sendable {
    public let stop: Double; public let take: Double; public let trailStart: Double; public let trail: Double
    public let holdMs: Int64; public let partialBps: Int
}
public struct Position: Codable, Equatable, Sendable, Identifiable {
    public let id: String; public let mint: MintAddress; public let symbol: String; public let decimals: Int; public let bucket: AllocationName; public let strategy: String
    public let quantityRaw: RawAmount; public let costLamports: RawAmount; public let openedAt: Int64; public let entrySignature: String?
    public let markLamports: RawAmount?; public let markAt: Int64?; public let peakLamports: RawAmount; public let quoteFailures: Int
    public let protection: Protection; public let partialTaken: Bool; public let queuedSellRaw: RawAmount; public let exitReason: String?
    public let entryReference: ReferenceValue; public let entryMcapUsd: Double?; public let entryFx: FxValue?
    public let markStale: Bool; public let estimatedPnlLamports: RawAmount?; public let pnlPercent: Double?
    public var quantityText: String { quantityRaw.formatted(decimals: decimals) }
    public var pnlText: String { markStale ? "—" : estimatedPnlLamports?.formatted(includePlus: true) ?? "—" }
}
public struct NativeAudit: Codable, Equatable, Sendable {
    public let base: String; public let side: String; public let mint: MintAddress; public let inputRaw: RawAmount; public let minimumRaw: RawAmount
    public let tipLamports: Int64; public let feeLamports: Int64; public let rentDeltaLamports: Int64; public let tokenAccounts: [MintAddress]
}
public struct Settlement: Codable, Equatable, Sendable {
    public let kind: String; public let base: String?; public let baseDelta: RawAmount?; public let tokenDelta: RawAmount?
    public let nativeSpent: Int64?; public let feeLamports: Int64?; public let tipLamports: Int64?; public let rentDeltaLamports: Int64?; public let confirmation: String?
    public func matchesFinancialEffects(of other: Settlement) -> Bool {
        kind == other.kind && base == other.base && baseDelta == other.baseDelta && tokenDelta == other.tokenDelta
        && nativeSpent == other.nativeSpent && feeLamports == other.feeLamports && tipLamports == other.tipLamports && rentDeltaLamports == other.rentDeltaLamports
    }
}
public struct TradeOrder: Codable, Equatable, Sendable, Identifiable {
    public let id: String; public let commandId: String?; public let side: String; public let mint: MintAddress; public let symbol: String
    public let decimals: Int; public let bucket: AllocationName; public let amountRaw: RawAmount; public let stage: RemoteStage
    public let createdAt: Int64; public let updatedAt: Int64; public let reason: String?; public let strategy: String
    public let reserveLamports: RawAmount; public let signature: String?; public let applied: Bool; public let receipt: Settlement?
    public let preparationMs: Double?; public let transportMs: Double?; public let fillMs: Double?
    public func displayStage(mode: TradingMode) -> String {
        if stage.rawValue == "finalized", receipt?.kind == "success" { return mode == .paper ? "Paper fill" : "Filled · finalized" }
        return stage.display
    }
}
public struct CommandRecord: Codable, Equatable, Sendable, Identifiable {
    public let id: String; public let hash: String; public let type: String; public let at: Int64
    public let stage: RemoteStage; public let reason: String?; public let orderId: String?
}
public struct CopyHealth: Codable, Equatable, Sendable {
    public let leader: MintAddress?; public let blocked: String?; public let lastPollAt: Int64?; public let lastSignalAt: Int64?
    public let streamReady: Bool; public let estimatedHistoryCredits: Int
}
public struct EngineHealth: Codable, Equatable, Sendable {
    public let lastTick: Int64?; public let lastError: String?; public let lastObservation: Int64?; public let monitorMs: Int
}
public struct PortfolioSnapshot: Codable, Equatable, Sendable {
    public let mode: TradingMode; public let base: String; public let wallet: String; public let seq: Int64; public let reportingDay: String; public let timezone: String
    public let cashLamports: RawAmount; public let equityLamports: RawAmount?; public let equityUsd: Double?; public let equityEur: Double?
    public let realizedTradingLamports: RawAmount; public let capitalChangeLamports: RawAmount?; public let referenceOnlyChangeUsd: Double?
    public let maxAffordableBuyLamports: AffordableAmounts; public let reference: ReferenceValue?; public let fx: FxValue?
    public let feesLamports: RawAmount; public let rentLamports: RawAmount; public let reservedLamports: RawAmount; public let unreservedCashLamports: RawAmount
    public let allocations: AllocationSet; public let settings: BotSettings; public let halt: String?; public let positions: [Position]
    public let pending: [TradeOrder]; public let recentOrders: [TradeOrder]; public let recentCommands: [CommandRecord]; public let copy: CopyHealth; public let health: EngineHealth
    public func validated() throws -> Self {
        guard base == "SOL", seq >= 0, !cashLamports.isNegative, !reservedLamports.isNegative,
              !unreservedCashLamports.isNegative, positions.count <= 4, pending.count <= 1,
              allocations.normal.pct + allocations.copy.pct + allocations.reserve.pct == 100,
              [allocations.normal, allocations.copy, allocations.reserve].allSatisfy({ (0...100).contains($0.pct) && !$0.cashLamports.isNegative }),
              allocations.normal.cashLamports.decimal + allocations.copy.cashLamports.decimal + allocations.reserve.cashLamports.decimal == cashLamports.decimal,
              Set(positions.map(\.mint)).count == positions.count,
              positions.allSatisfy({ (0...18).contains($0.decimals) && !$0.quantityRaw.isNegative && !$0.quantityRaw.isZero && !$0.costLamports.isNegative && $0.bucket != .reserve }) else { throw ModelError.malformedFrame }
        return self
    }
}
public struct SafetyCheck: Codable, Equatable, Sendable { public let key: String; public let status: String; public let detail: String }
public struct SafetyReport: Codable, Equatable, Sendable {
    public let mint: MintAddress; public let isSafe: Bool; public let status: String; public let riskReason: String
    public let checkedAt: Int64; public let expiresAt: Int64; public let checks: [SafetyCheck]
    public let top10Pct: Double?; public let lpLockedPct: Double?; public let rugScore: Double?
}
public struct FeedToken: Codable, Equatable, Sendable, Identifiable {
    public var id: MintAddress { mint }
    public let mint: MintAddress; public let name: String; public let symbol: String; public let imageUri: String?
    public let mcapUsd: Double?; public let fdvUsd: Double?; public let change5mPct: Double?; public let liquidityUsd: Double?
    public let volume5mUsd: Double?; public let createdAt: Int64?; public let observedAt: Int64; public let source: String; public let estimated: Bool
    public let bondingPct: Double?; public let migrated: Bool; public let isSafe: Bool; public let riskStatus: String; public let riskReason: String
    public let sparkline: [Double]; public let metadataAt: Int64?
    public func checkLabel(serverNow: Int64) -> String {
        guard serverNow >= observedAt - 1000, serverNow - observedAt < 15000,
              let metadataAt, serverNow - metadataAt < 15000, serverNow >= metadataAt - 1000 else { return "Not verified" }
        return riskStatus == "risky" ? "Checks failed" : riskStatus == "eligible" && isSafe ? "Checks passed" : "Not verified"
    }
}
public struct FeedSnapshot: Codable, Equatable, Sendable { public let tokens: [FeedToken] }
public struct MarketPoint: Codable, Equatable, Sendable, Identifiable {
    public var id: Int64 { at }
    public let at: Int64; public let mcapUsd: Double
    public init(at: Int64, mcapUsd: Double) { self.at = at; self.mcapUsd = mcapUsd }
}
public struct ChartHistory: Codable, Equatable, Sendable { public let mint: MintAddress; public let points: [MarketPoint]; public let safety: SafetyReport? }
public struct TradeEventData: Codable, Equatable, Sendable {
    public let orderId: String; public let mint: MintAddress?; public let side: String?; public let mode: TradingMode?
    public let signature: String?; public let confirmation: String?; public let fillMs: Double?; public let receipt: Settlement?
}
public struct TradeAlert: Codable, Equatable, Sendable {
    public let seq: Int64; public let at: Int64; public let type: String; public let data: TradeEventData; public let mode: TradingMode
    public var isFill: Bool {
        type == "TRADE_FILLED" && data.mode == mode && data.receipt?.kind == "success" && data.receipt?.base == "SOL"
        && data.receipt?.confirmation == data.confirmation && ["confirmed", "finalized"].contains(data.confirmation ?? "")
    }
    public var display: String {
        if isFill { return mode == .paper ? "Paper fill" : data.confirmation == "finalized" ? "Filled · finalized" : "Filled · confirmed" }
        return type == "TRADE_FAILED" ? "Transaction failed" : "Submitted"
    }
}
public struct ProtocolErrorPayload: Codable, Equatable, Sendable { public let error: String }
public struct StrategyResult: Codable, Equatable, Sendable {
    public let strategy: String; public let bucket: String; public let entries: Int; public let closedTrades: Int; public let wins: Int; public let losses: Int; public let flat: Int
    public let failedTransactions: Int; public let realizedLamports: RawAmount; public let feesLamports: RawAmount; public let rentLamports: RawAmount; public let entryCostLamports: RawAmount
    public let winRatePct: Double?; public let profitFactor: Double?; public let openPositions: Int
}
public struct StrategyReport: Codable, Equatable, Sendable {
    public let mode: TradingMode; public let base: String; public let at: Int64; public let source: String; public let containsUnfinalizedEffects: Bool
    public let realizedTradingLamports: RawAmount; public let note: String; public let strategies: [StrategyResult]
}
public struct Envelope<T: Decodable & Sendable>: Decodable, Sendable {
    public let v: Int; public let type: String; public let seq: Int64; public let at: Int64; public let ledgerSeq: Int64; public let data: T
}
private struct FrameHeader: Decodable { let v: Int; let type: String; let seq: Int64; let at: Int64; let ledgerSeq: Int64 }
public enum ServerMessage: Sendable {
    case portfolio(Envelope<PortfolioSnapshot>), feed(Envelope<FeedSnapshot>), chart(Envelope<ChartHistory>)
    case command(Envelope<CommandRecord>), error(Envelope<ProtocolErrorPayload>), alert(Envelope<TradeAlert>)
    case performance(Envelope<StrategyReport>)
    case unknown(type: String, sequence: Int64)
    public var sequence: Int64 {
        switch self { case .portfolio(let e): e.seq; case .feed(let e): e.seq; case .chart(let e): e.seq; case .command(let e): e.seq; case .error(let e): e.seq; case .alert(let e): e.seq; case .performance(let e): e.seq; case .unknown(_, let s): s }
    }
    public static func decode(_ data: Data) throws -> ServerMessage {
        guard data.count <= 1_000_000 else { throw ModelError.oversizedFrame }
        let decoder = JSONDecoder(), header = try decoder.decode(FrameHeader.self, from: data)
        guard header.v == 1 else { throw ModelError.unsupportedProtocol }
        guard header.seq > 0, header.at >= 0, header.ledgerSeq >= 0 else { throw ModelError.malformedFrame }
        switch header.type {
        case "PORTFOLIO_UPDATE":
            let envelope = try decoder.decode(Envelope<PortfolioSnapshot>.self, from: data); _ = try envelope.data.validated(); return .portfolio(envelope)
        case "FEED_UPDATE":
            let e = try decoder.decode(Envelope<FeedSnapshot>.self, from: data)
            guard e.data.tokens.count <= 500, Set(e.data.tokens.map(\.mint)).count == e.data.tokens.count, e.data.tokens.allSatisfy({ $0.sparkline.count <= 30 }) else { throw ModelError.malformedFrame }; return .feed(e)
        case "CHART_HISTORY":
            let e = try decoder.decode(Envelope<ChartHistory>.self, from: data); guard e.data.points.count <= 512 else { throw ModelError.malformedFrame }; return .chart(e)
        case "COMMAND_ACK": return .command(try decoder.decode(Envelope<CommandRecord>.self, from: data))
        case "COMMAND_ERROR": return .error(try decoder.decode(Envelope<ProtocolErrorPayload>.self, from: data))
        case "TRADE_ALERT": return .alert(try decoder.decode(Envelope<TradeAlert>.self, from: data))
        case "STRATEGY_REPORT": return .performance(try decoder.decode(Envelope<StrategyReport>.self, from: data))
        default: return .unknown(type: header.type, sequence: header.seq)
        }
    }
}
