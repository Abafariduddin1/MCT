import Foundation

public enum CommandPayload: Codable, Equatable, Sendable {
    case buy(mint: MintAddress, amount: SolAmount)
    case sell(mint: MintAddress, percentBps: Int)
    case preset(BotPreset, autoPilot: Bool, normalEnabled: Bool, copyEnabled: Bool, amount: SolAmount)
    case allocations(normal: Int, copy: Int, reserve: Int)
    case pause(Bool)
    case panic
    public var isFinancial: Bool { switch self { case .buy, .sell: true; default: false } }
    public var wireType: String {
        switch self { case .buy, .sell: "QUICK_TRADE"; case .preset: "SET_BOT_PRESET"; case .allocations: "SET_ALLOCATIONS"; case .pause: "PAUSE_ENTRIES"; case .panic: "PANIC_CASH_OUT_ALL" }
    }
    public func validated() throws -> Self {
        switch self {
        case .sell(_, let bps): guard (1...10000).contains(bps) else { throw ModelError.invalidCommand }
        case .allocations(let n, let c, let r): guard [n, c, r].allSatisfy({ (0...100).contains($0) }), n + c + r == 100 else { throw ModelError.invalidCommand }
        default: break
        }
        return self
    }
    private enum Keys: String, CodingKey { case type, side, mint, amountSol, percentBps, preset, autoPilot, normalEnabled, copyEnabled, normalPct, copyPct, reservePct, paused }
    public func encode(to encoder: Encoder) throws {
        _ = try validated(); var c = encoder.container(keyedBy: Keys.self); try c.encode(wireType, forKey: .type)
        switch self {
        case .buy(let mint, let amount): try c.encode("buy", forKey: .side); try c.encode(mint, forKey: .mint); try c.encode(amount, forKey: .amountSol)
        case .sell(let mint, let percent): try c.encode("sell", forKey: .side); try c.encode(mint, forKey: .mint); try c.encode(percent, forKey: .percentBps)
        case .preset(let p, let on, let normal, let copy, let amount):
            try c.encode(p, forKey: .preset); try c.encode(on, forKey: .autoPilot); try c.encode(normal, forKey: .normalEnabled); try c.encode(copy, forKey: .copyEnabled); try c.encode(amount, forKey: .amountSol)
        case .allocations(let n, let copy, let r): try c.encode(n, forKey: .normalPct); try c.encode(copy, forKey: .copyPct); try c.encode(r, forKey: .reservePct)
        case .pause(let paused): try c.encode(paused, forKey: .paused)
        case .panic: break
        }
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self), type = try c.decode(String.self, forKey: .type)
        switch type {
        case "QUICK_TRADE":
            let mint = try c.decode(MintAddress.self, forKey: .mint), side = try c.decode(String.self, forKey: .side)
            if side == "buy" { self = .buy(mint: mint, amount: try c.decode(SolAmount.self, forKey: .amountSol)) }
            else if side == "sell" { self = .sell(mint: mint, percentBps: try c.decode(Int.self, forKey: .percentBps)) }
            else { throw ModelError.invalidCommand }
        case "SET_BOT_PRESET": self = .preset(try c.decode(BotPreset.self, forKey: .preset), autoPilot: try c.decode(Bool.self, forKey: .autoPilot), normalEnabled: try c.decode(Bool.self, forKey: .normalEnabled), copyEnabled: try c.decode(Bool.self, forKey: .copyEnabled), amount: try c.decode(SolAmount.self, forKey: .amountSol))
        case "SET_ALLOCATIONS": self = .allocations(normal: try c.decode(Int.self, forKey: .normalPct), copy: try c.decode(Int.self, forKey: .copyPct), reserve: try c.decode(Int.self, forKey: .reservePct))
        case "PAUSE_ENTRIES": self = .pause(try c.decode(Bool.self, forKey: .paused))
        case "PANIC_CASH_OUT_ALL": self = .panic
        default: throw ModelError.invalidCommand
        }
        _ = try validated()
    }
}
public struct CommandEnvelope: Codable, Equatable, Sendable, Identifiable {
    public let id: String; public let payload: CommandPayload
    public init(id: String = UUID().uuidString, payload: CommandPayload) throws {
        guard (16...80).contains(id.count), id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { throw ModelError.invalidCommand }
        self.id = id; self.payload = try payload.validated()
    }
    private enum Keys: String, CodingKey { case v, id }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        guard try c.decode(Int.self, forKey: .v) == 1 else { throw ModelError.unsupportedProtocol }
        try self.init(id: c.decode(String.self, forKey: .id), payload: CommandPayload(from: decoder))
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self); try c.encode(1, forKey: .v); try c.encode(id, forKey: .id); try payload.encode(to: encoder)
    }
    public func data() throws -> Data { let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return try encoder.encode(self) }
}
public enum ReadRequest: Encodable, Sendable {
    case snapshot, chart(MintAddress), performance
    private enum Keys: String, CodingKey { case v, type, mint }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self); try c.encode(1, forKey: .v)
        switch self {
        case .snapshot: try c.encode("GET_SNAPSHOT", forKey: .type)
        case .chart(let mint): try c.encode("GET_CHART", forKey: .type); try c.encode(mint, forKey: .mint)
        case .performance: try c.encode("GET_PERFORMANCE", forKey: .type)
        }
    }
}
