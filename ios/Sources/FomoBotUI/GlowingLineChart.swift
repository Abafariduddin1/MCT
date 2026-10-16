#if canImport(SwiftUI)
import SwiftUI
import FomoBotCore

public struct GlowingLineChart: View {
    private let points: [MarketPoint]
    private let serverClockOffset: TimeInterval
    @State private var timeframe: ChartTimeframe = .all
    @State private var selection: MarketPoint?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init(points: [MarketPoint], serverClockOffset: TimeInterval = 0) { self.points = points; self.serverClockOffset = serverClockOffset }
    public var body: some View {
        TimelineView(.periodic(from: .now, by: 10)) { timeline in
            let now = Int64((timeline.date.timeIntervalSince1970 + serverClockOffset) * 1000)
            let all = ObservedSeries(points), series = all.visible(timeframe, now: now), stale = series.isStale(now: now)
            let chosen = selection.flatMap { selected in series.points.first { $0.at == selected.at } } ?? series.points.last
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    Text(DisplayFormat.marketCap(chosen?.mcapUsd)).font(BotTheme.numberFont(.title)).monospacedDigit()
                    Spacer()
                    if let chosen { Text(Date(timeIntervalSince1970: Double(chosen.at) / 1000), style: .time).font(.caption).foregroundStyle(BotTheme.muted) }
                }
                GeometryReader { geometry in
                    let size = geometry.size
                    ZStack {
                        if series.points.isEmpty {
                            VStack(spacing: 8) { Image(systemName: "chart.xyaxis.line"); Text("Waiting for observed history") }.font(.subheadline).foregroundStyle(BotTheme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
                        } else {
                            ObservedLine(series: series).stroke(BotTheme.positive.opacity(0.18), style: StrokeStyle(lineWidth: 8, lineCap: .round)).blur(radius: 5).accessibilityHidden(true)
                            ObservedLine(series: series).stroke(BotTheme.positive, style: StrokeStyle(lineWidth: 2, lineCap: .round)).accessibilityHidden(true)
                            if let last = series.points.last {
                                let p = series.normalized(last)
                                Circle().fill(stale ? BotTheme.muted : BotTheme.positive).frame(width: 7, height: 7).position(x: size.width * p.x, y: size.height * p.y).accessibilityHidden(true)
                            }
                            if let chosen, selection != nil {
                                let p = series.normalized(chosen)
                                Rectangle().fill(BotTheme.muted.opacity(0.6)).frame(width: 1).position(x: size.width * p.x, y: size.height / 2)
                                Circle().fill(Color.white).frame(width: 8, height: 8).position(x: size.width * p.x, y: size.height * p.y)
                            }
                        }
                    }.contentShape(Rectangle())
                        .gesture(DragGesture(minimumDistance: 8).onChanged { drag in
                            guard let first = series.points.first, let last = series.points.last, size.width > 0 else { return }
                            let fraction = min(1, max(0, drag.location.x / size.width)), timestamp = first.at + Int64(Double(last.at - first.at) * fraction)
                            let next = series.nearest(to: timestamp)
                            if next?.at != selection?.at { selection = next; Haptics.shared.scrub() }
                        }.onEnded { _ in selection = nil })
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Observed market capitalization chart")
                        .accessibilityValue(chosen.map { DisplayFormat.marketCap($0.mcapUsd) + ", " + Date(timeIntervalSince1970: Double($0.at) / 1000).formatted(date: .abbreviated, time: .shortened) + (stale ? ", stale" : "") } ?? "No observations")
                        .accessibilityAdjustableAction { direction in
                            guard !series.points.isEmpty else { return }
                            let current = selection.flatMap { p in series.points.firstIndex { $0.at == p.at } } ?? series.points.count - 1
                            let index = direction == .increment ? min(series.points.count - 1, current + 1) : max(0, current - 1)
                            selection = series.points[index]
                        }
                }.frame(height: 190)
                HStack(spacing: 8) {
                    ForEach(ChartTimeframe.allCases) { interval in
                        Button { timeframe = interval; selection = nil; Haptics.shared.tap() } label: {
                            Text(interval.rawValue).font(.system(.caption, design: .rounded, weight: .semibold)).padding(.horizontal, 12).frame(minHeight: 44)
                                .foregroundStyle(timeframe == interval ? Color.white : BotTheme.muted)
                                .background(timeframe == interval ? BotTheme.border : Color.clear, in: Capsule())
                        }.disabled(!all.isAvailable(interval, now: now)).opacity(all.isAvailable(interval, now: now) ? 1 : 0.4)
                            .accessibilityLabel(interval == .all ? "All observed history" : "Observed history: " + interval.rawValue)
                    }
                    Spacer(minLength: 0)
                }
                Text(series.points.isEmpty ? "History appears as observations arrive." : stale ? "Last observation is stale. Gaps are left visible." : "Observed history · " + String(series.points.count) + " samples")
                    .font(.caption).foregroundStyle(BotTheme.muted)
            }.animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: timeframe)
                .onAppear { Haptics.shared.prepare() }
        }
    }
}
private struct ObservedLine: Shape {
    let series: ObservedSeries
    func path(in rect: CGRect) -> Path {
        var path = Path()
        for segment in series.segments() {
            for (index, point) in segment.enumerated() {
                let p = series.normalized(point), at = CGPoint(x: rect.width * p.x, y: rect.height * p.y)
                if index == 0 { path.move(to: at) } else { path.addLine(to: at) }
            }
        }
        return path
    }
}
#endif
