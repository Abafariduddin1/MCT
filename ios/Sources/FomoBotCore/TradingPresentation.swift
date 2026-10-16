import Foundation

public enum TradingSection: String, CaseIterable, Sendable, Identifiable {
    case paper, live, copy
    public var id: String { rawValue }
    public var title: String { switch self { case .paper: "Paper trading"; case .live: "Real trading"; case .copy: "Copy trading" } }
    public var symbol: String { switch self { case .paper: "testtube.2"; case .live: "bolt.fill"; case .copy: "person.2.fill" } }
}

/// Profiles describe connections, not permission to change the server's mode.
@MainActor public final class TradingProfiles {
    private let defaults: UserDefaults
    private let key = "fomobot.controller.profiles.v1"
    private struct Saved: Codable { let version: Int; var endpoints: [String: BackendEndpoint] }
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    private func read() throws -> Saved {
        guard let bytes = defaults.data(forKey: key) else { return Saved(version: 1, endpoints: [:]) }
        let saved = try JSONDecoder().decode(Saved.self, from: bytes)
        guard saved.version == 1, saved.endpoints.keys.allSatisfy({ TradingMode(rawValue: $0) != nil }) else { throw ModelError.invalidEndpoint }
        return saved
    }
    public func endpoint(for mode: TradingMode) throws -> BackendEndpoint? { try read().endpoints[mode.rawValue] }
    public func save(_ endpoint: BackendEndpoint, for mode: TradingMode) throws {
        var saved = try read(); saved.endpoints[mode.rawValue] = endpoint
        defaults.set(try JSONEncoder().encode(saved), forKey: key)
    }
    public func remove(for mode: TradingMode) throws {
        var saved = try read(); saved.endpoints.removeValue(forKey: mode.rawValue)
        defaults.set(try JSONEncoder().encode(saved), forKey: key)
    }
}

public enum FeedFilter: String, CaseIterable, Identifiable, Sendable {
    case trending = "Trending", new = "New", graduating = "Graduating"
    public var id: String { rawValue }
    public func tokens(_ values: [FeedToken], now: Int64) -> [FeedToken] {
        switch self {
        case .trending:
            // Rank observations by reported activity. A paid boost is not a
            // trading signal and an unobserved surge is never fabricated.
            return values.sorted {
                if ($0.volume5mUsd ?? -1) != ($1.volume5mUsd ?? -1) { return ($0.volume5mUsd ?? -1) > ($1.volume5mUsd ?? -1) }
                return $0.observedAt > $1.observedAt
            }
        case .new: return values.filter { $0.createdAt.map { now >= $0 && now - $0 <= 86400000 } == true }.sorted { ($0.createdAt ?? 0) > ($1.createdAt ?? 0) }
        case .graduating: return values.filter { !$0.migrated && ($0.bondingPct ?? -1) >= 85 && ($0.bondingPct ?? 101) < 100 }.sorted { ($0.bondingPct ?? 0) > ($1.bondingPct ?? 0) }
        }
    }
}

public enum BuySizing {
    /// Display choices are derived from the backend ceiling using exact Decimal
    /// arithmetic. The backend still checks the complete token/quote policy.
    public static func choices(maximum: RawAmount, reference: ReferenceValue?, now: Int64) -> [SolAmount] {
        guard !maximum.isNegative, !maximum.isZero, let reference, reference.solUsdc.isFinite, reference.solUsdc > 0,
              now >= reference.at - 1000, now - reference.at <= 15000,
              let price = Decimal(string: String(reference.solUsdc), locale: Locale(identifier: "en_US_POSIX")) else { return [] }
        var output: [SolAmount] = []
        for fraction in [1, 2, 4] {
            var value = maximum.decimal * Decimal(fraction) / 4, whole = Decimal()
            NSDecimalRound(&whole, &value, 0, .down)
            guard whole * price >= 1_000_000_000, let raw = try? RawAmount(NSDecimalNumber(decimal: whole).stringValue),
                  let option = try? SolAmount(raw.formatted(maximumFractionDigits: 9)), !output.contains(where: { $0.lamports == option.lamports }) else { continue }
            output.append(option)
        }
        return output
    }
    public static func blockReason(token: FeedToken?, portfolio: PortfolioSnapshot?, isFresh: Bool, now: Int64) -> String? {
        guard isFresh, let portfolio else { return "Connect to a current portfolio first." }
        if !portfolio.pending.isEmpty { return "Waiting for the existing trade to resolve." }
        if portfolio.settings.panic { return "Selling managed tokens to SOL." }
        if portfolio.settings.paused { return "New entries are paused." }
        if let halt = portfolio.halt ?? portfolio.allocations.normal.halt { return halt }
        guard let token else { return "Waiting for token information." }
        if portfolio.positions.contains(where: { $0.mint == token.mint }) { return "This token is already held. Use its sell controls." }
        if token.checkLabel(serverNow: now) != "Checks passed" { return token.riskReason.isEmpty ? "Token checks are incomplete." : token.riskReason }
        if choices(maximum: portfolio.maxAffordableBuyLamports.normal, reference: portfolio.reference, now: now).isEmpty { return "No order fits the current balance and limits." }
        return nil
    }
}
