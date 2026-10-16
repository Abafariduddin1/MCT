import Foundation

public enum ChartTimeframe: String, CaseIterable, Sendable, Identifiable {
    case minute = "1m", fiveMinutes = "5m", hour = "1h", all = "All"
    public var id: String { rawValue }
    public var milliseconds: Int64? { switch self { case .minute: 60000; case .fiveMinutes: 300000; case .hour: 3600000; case .all: nil } }
}
public struct ObservedSeries: Sendable {
    public let points: [MarketPoint]
    public init(_ values: [MarketPoint]) {
        var unique: [Int64: MarketPoint] = [:]
        for p in values.suffix(2048) where p.at >= 0 && p.mcapUsd.isFinite && p.mcapUsd >= 0 { unique[p.at] = p }
        points = Array(unique.values.sorted { $0.at < $1.at }.suffix(512))
    }
    public var observedSpan: Int64 { guard let first = points.first, let last = points.last else { return 0 }; return last.at - first.at }
    public func isAvailable(_ timeframe: ChartTimeframe, now: Int64) -> Bool {
        guard points.count >= 2 else { return false }
        guard let duration = timeframe.milliseconds else { return true }
        return observedSpan >= duration && points.filter({ $0.at >= now - duration && $0.at <= now + 1000 }).count >= 2
    }
    public func visible(_ timeframe: ChartTimeframe, now: Int64) -> ObservedSeries {
        guard let duration = timeframe.milliseconds else { return ObservedSeries(points.filter { $0.at <= now + 1000 }) }
        return ObservedSeries(points.filter { $0.at >= now - duration && $0.at <= now + 1000 })
    }
    public func isStale(now: Int64, maximumAge: Int64 = 30000) -> Bool {
        guard let last = points.last else { return true }; return last.at > now + 1000 || now - last.at > maximumAge
    }
    public func segments(maximumGap: Int64 = 60000) -> [[MarketPoint]] {
        var groups: [[MarketPoint]] = []
        for point in points { if let last = groups.last?.last, point.at - last.at <= maximumGap { groups[groups.count - 1].append(point) } else { groups.append([point]) } }
        return groups
    }
    public func nearest(to timestamp: Int64) -> MarketPoint? {
        guard let first = points.first, let last = points.last else { return nil }
        if timestamp <= first.at { return first }; if timestamp >= last.at { return last }
        var lo = 0, hi = points.count - 1
        while lo + 1 < hi { let mid = (lo + hi) / 2; if points[mid].at < timestamp { lo = mid } else { hi = mid } }
        return timestamp - points[lo].at <= points[hi].at - timestamp ? points[lo] : points[hi]
    }
    public func normalized(_ point: MarketPoint) -> (x: Double, y: Double) {
        guard let first = points.first, let last = points.last else { return (0.5, 0.5) }
        let low = points.map(\.mcapUsd).min() ?? 0, high = points.map(\.mcapUsd).max() ?? 0
        let x = first.at == last.at ? 0.5 : Double(point.at - first.at) / Double(last.at - first.at)
        let y = low == high ? 0.5 : 0.9 - (point.mcapUsd - low) / (high - low) * 0.8
        return (min(1, max(0, x)), min(1, max(0, y)))
    }
}
