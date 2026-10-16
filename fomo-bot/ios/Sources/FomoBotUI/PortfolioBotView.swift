#if canImport(SwiftUI) && os(iOS)
import SwiftUI
import FomoBotCore

public struct PortfolioBotView: View {
    let model: TradingAppModel
    public init(model: TradingAppModel) { self.model = model }
    public var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 16) {
                    if let p = model.portfolio {
                        PortfolioBalance(model: model)
                        if let halt = p.halt { StatusPill(halt, symbol: "pause.circle.fill", color: BotTheme.warning) }
                        AutoPilotCard(model: model)
                        AllocationCard(model: model)
                        CopyStatusCard(model: model)
                        SectionTitle(title: "Your positions", detail: p.pending.isEmpty ? "Estimated PnL uses an exit quote after costs." : "A trade is awaiting resolution.")
                        if p.positions.isEmpty { EmptyCard(title: "No open positions", detail: "The bot waits for entries that pass its strategy, token and cost checks.", symbol: "square.stack.3d.up") }
                        ForEach(p.positions) { PositionCard(model: model, position: $0) }
                        PendingTrades(model: model)
                        PanicControl(model: model)
                        PerformanceCard(model: model)
                        ActivityCard(model: model)
                    } else {
                        EmptyCard(title: "Portfolio unavailable", detail: "Connect this profile to its matching backend.", symbol: "wifi.exclamationmark")
                        Button("Set up connection") { model.needsConnection = true }.buttonStyle(BotActionStyle())
                    }
                }.padding(16)
            }.background(BotTheme.background).navigationTitle("Portfolio")
                .refreshable { try? await model.client.requestSnapshot(); try? await model.client.requestPerformance() }
                .task(id: model.portfolio?.seq) { if model.isReady { try? await model.client.requestPerformance() } }
        }.tint(BotTheme.positive)
    }
}

struct PortfolioBalance: View {
    let model: TradingAppModel
    var body: some View {
        if let p = model.portfolio {
            VStack(alignment: .leading, spacing: 14) {
                HStack { Text("Managed portfolio").font(.subheadline).foregroundStyle(BotTheme.muted); Spacer(); ModeBadge(p.mode) }
                NativeAmountLabel(p.equityLamports, isStale: !model.isReady)
                HStack {
                    Text(model.isReady ? ScreenFormat.money(p.equityEur, currency: "EUR") : "—").font(.title3.weight(.semibold))
                    Text("≈ " + (model.isReady ? ScreenFormat.money(p.equityUsd) : "—")).font(.caption).foregroundStyle(BotTheme.muted)
                }
                Divider().overlay(BotTheme.border)
                MetricRow(title: "Available cash", value: p.unreservedCashLamports.formatted() + " SOL")
                MetricRow(title: "Reserved for pending orders", value: p.reservedLamports.formatted() + " SOL")
                MetricRow(title: "Realized trading · recorded", value: p.realizedTradingLamports.formatted(includePlus: true) + " SOL", color: p.realizedTradingLamports.isNegative ? BotTheme.negative : BotTheme.positive)
                MetricRow(title: "Total native capital change", value: model.isReady ? (p.capitalChangeLamports?.formatted(includePlus: true) ?? "—") + " SOL" : "—")
                MetricRow(title: "Original SOL reference move", value: model.isReady ? ScreenFormat.money(p.referenceOnlyChangeUsd) : "—")
                Text("Reporting day " + p.reportingDay + " · " + p.timezone + ". Reference currency values are estimates.").font(.caption2).foregroundStyle(BotTheme.muted)
            }.botCard()
        }
    }
}

struct PositionCard: View {
    let model: TradingAppModel
    let position: Position
    private var token: FeedToken? { model.client.feed.first { $0.mint == position.mint } }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                TokenAvatar(symbol: position.symbol, uri: token?.imageUri, size: 38)
                VStack(alignment: .leading, spacing: 3) {
                    Text(position.symbol).font(.system(.headline, design: .rounded, weight: .bold))
                    Text(position.bucket == .copy ? "Copy trading" : position.strategy.capitalized).font(.caption).foregroundStyle(BotTheme.muted)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 3) {
                    Text(model.isReady ? position.pnlText + " SOL" : "—").font(.subheadline.weight(.bold)).foregroundStyle(BotTheme.movement(position.pnlPercent))
                    Text(model.isReady && !position.markStale ? DisplayFormat.percent(position.pnlPercent) : "Exit value unavailable").font(.caption).foregroundStyle(BotTheme.muted)
                }
            }
            MetricRow(title: "Quantity", value: position.quantityText)
            MetricRow(title: "Entry market cap", value: DisplayFormat.marketCap(position.entryMcapUsd))
            MetricRow(title: "Observed market cap", value: token.flatMap { model.isReady && model.serverNow >= $0.observedAt - 1000 && model.serverNow - $0.observedAt < 15000 ? $0.mcapUsd : nil }.map { DisplayFormat.marketCap($0) } ?? "—")
            if let reason = position.exitReason { Text(reason).font(.caption).foregroundStyle(BotTheme.warning) }
            if !position.queuedSellRaw.isZero { Text("A leader sale is queued for this position.").font(.caption).foregroundStyle(BotTheme.warning) }
            HStack(spacing: 10) {
                Button("Sell 50%") { Haptics.shared.tap(); Task { await model.sell(position, bps: 5000) } }
                Button("Sell all") { Haptics.shared.tap(); Task { await model.sell(position, bps: 10000) } }
            }.buttonStyle(.bordered).tint(BotTheme.negative).controlSize(.large)
                .disabled(!model.isReady || model.client.hasPendingFinancialAction)
            DisclosureGroup("Exit plan") {
                VStack(spacing: 8) {
                    MetricRow(title: "Stop trigger", value: DisplayFormat.percent(-position.protection.stop))
                    MetricRow(title: "Profit target", value: DisplayFormat.percent(position.protection.take))
                    MetricRow(title: "Trailing distance", value: DisplayFormat.percent(position.protection.trail))
                    MetricRow(title: "Maximum hold", value: "\(position.protection.holdMs / 60000) min")
                    Text("An exit trigger requests a sale; the result depends on the available route.").font(.caption2).foregroundStyle(BotTheme.muted)
                }.padding(.top, 8)
            }.font(.caption).foregroundStyle(BotTheme.muted)
        }.botCard()
    }
}

struct PendingTrades: View {
    let model: TradingAppModel
    var body: some View {
        if let p = model.portfolio, !p.pending.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                SectionTitle(title: "Pending trade")
                ForEach(p.pending) { order in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(order.side.uppercased() + " " + order.symbol + " · " + order.displayStage(mode: p.mode)).font(.subheadline.weight(.semibold))
                        if let reason = order.reason { Text(reason).font(.caption).foregroundStyle(BotTheme.warning) }
                        Text(order.id).font(.caption2.monospaced()).textSelection(.enabled)
                        Text("The original request is retained. A reconnect does not repeat it.").font(.caption2).foregroundStyle(BotTheme.muted)
                    }
                }
            }.botCard()
        }
    }
}
struct PanicControl: View {
    let model: TradingAppModel
    @State private var confirming = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(role: .destructive) { confirming = true } label: {
                Label("Sell all tokens to SOL", systemImage: "stop.circle.fill").font(.headline).frame(maxWidth: .infinity, minHeight: 50)
            }.buttonStyle(.bordered).tint(BotTheme.negative)
                .disabled(!model.isReady || model.portfolio.map { $0.positions.isEmpty && $0.pending.isEmpty } != false)
            Text("Stops new entries and requests sales of managed tokens. Pending and unsold positions stay visible.").font(.caption2).foregroundStyle(BotTheme.muted)
        }.confirmationDialog("Sell every managed token to SOL?", isPresented: $confirming, titleVisibility: .visible) {
            Button(model.mode == .paper ? "Sell all · paper" : "Sell all · real funds", role: .destructive) { Task { await model.send(.panic) } }
        } message: { Text("SOL remains in your bot wallet. This does not convert it to euros.") }
    }
}
struct ActivityCard: View {
    let model: TradingAppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(title: "Activity", detail: "Acknowledged, submitted and filled are separate states.")
            ForEach((model.portfolio?.recentOrders ?? []).suffix(8).reversed()) { order in
                VStack(alignment: .leading, spacing: 5) {
                    Text(order.side.uppercased() + " " + order.symbol + " · " + order.displayStage(mode: model.mode)).font(.subheadline.weight(.semibold))
                    if let reason = order.reason { Text(reason).font(.caption).foregroundStyle(BotTheme.warning) }
                    if let ms = order.fillMs, order.applied { Text("Request to receipt: \(Int(ms)) ms").font(.caption2).foregroundStyle(BotTheme.muted) }
                    Text(order.id).font(.caption2.monospaced()).foregroundStyle(BotTheme.muted).textSelection(.enabled)
                }
            }
            ForEach(model.activeCommands.prefix(8)) { command in
                VStack(alignment: .leading, spacing: 4) {
                    Text(command.envelope.payload.wireType.replacingOccurrences(of: "_", with: " ")).font(.caption.weight(.semibold))
                    Text((command.mode == .paper ? "Paper" : "Real") + " · " + ScreenFormat.short(command.wallet)).font(.caption2).foregroundStyle(BotTheme.muted)
                    Text(command.remote?.stage.display ?? "Delivery unresolved").font(.caption).foregroundStyle(command.isUnresolved ? BotTheme.warning : BotTheme.muted)
                    if let reason = command.reviewReason ?? command.remote?.reason { Text(reason).font(.caption2).foregroundStyle(BotTheme.warning) }
                    Text(command.id).font(.caption2.monospaced()).textSelection(.enabled)
                }
            }
            if model.activeCommands.isEmpty && (model.portfolio?.recentOrders.isEmpty ?? true) { Text("Your orders and settings changes will appear here.").font(.caption).foregroundStyle(BotTheme.muted) }
        }.botCard()
    }
}
struct PerformanceCard: View {
    let model: TradingAppModel
    var body: some View {
        if let report = model.client.performance, report.mode == model.mode {
            VStack(alignment: .leading, spacing: 12) {
                SectionTitle(title: "Recorded strategy results", detail: "After recorded fees and rent. Open positions are counted separately.")
                ForEach(report.strategies, id: \.strategy) { result in
                    VStack(alignment: .leading, spacing: 6) {
                        MetricRow(title: result.strategy.capitalized + " · " + result.bucket, value: result.realizedLamports.formatted(includePlus: true) + " SOL", color: result.realizedLamports.isNegative ? BotTheme.negative : BotTheme.positive)
                        Text("\(result.closedTrades) closed · \(result.openPositions) open · \(result.failedTransactions) failed transactions").font(.caption2).foregroundStyle(BotTheme.muted)
                    }
                }
                if report.strategies.isEmpty { Text("No recorded results yet.").font(.caption).foregroundStyle(BotTheme.muted) }
                if report.containsUnfinalizedEffects { Text("Includes effects awaiting finality.").font(.caption).foregroundStyle(BotTheme.warning) }
            }.botCard()
        }
    }
}
#endif
