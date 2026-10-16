#if canImport(SwiftUI) && os(iOS)
import SwiftUI
import FomoBotCore

public struct TokenDetailSheet: View {
    let model: TradingAppModel
    let initialToken: FeedToken
    @Environment(\.dismiss) private var dismiss
    @State private var selection: String?
    public init(model: TradingAppModel, token: FeedToken) { self.model = model; initialToken = token }
    private var token: FeedToken { model.client.feed.first { $0.mint == initialToken.mint } ?? initialToken }
    private var position: Position? { model.portfolio?.positions.first { $0.mint == token.mint } }
    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 14) {
                        TokenAvatar(symbol: token.symbol, uri: token.imageUri, size: 58)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(token.symbol).font(.system(.title, design: .rounded, weight: .heavy))
                            Text(token.name).font(.subheadline).foregroundStyle(BotTheme.muted)
                        }
                        Spacer(); ModeBadge(model.mode)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text(model.isReady && model.serverNow >= token.observedAt - 1000 && model.serverNow - token.observedAt < 15000 ? DisplayFormat.marketCap(token.mcapUsd) : "—")
                            .font(.system(.largeTitle, design: .rounded, weight: .heavy)).monospacedDigit()
                        HStack {
                            Text("Market cap").foregroundStyle(BotTheme.muted)
                            Text(DisplayFormat.percent(token.change5mPct)).foregroundStyle(BotTheme.movement(token.change5mPct))
                        }.font(.subheadline)
                        Text("Last observed " + ScreenFormat.time(token.observedAt) + (token.estimated ? " · estimated" : "")).font(.caption2).foregroundStyle(BotTheme.muted)
                    }
                    SafetyDetails(model: model, token: token)
                    GlowingLineChart(points: model.client.charts[token.mint]?.points ?? [], serverClockOffset: model.client.serverClockOffset).botCard()
                    if let position { PositionCard(model: model, position: position) }
                    VStack(spacing: 10) {
                        MetricRow(title: "Liquidity", value: ScreenFormat.money(token.liquidityUsd))
                        MetricRow(title: "Five-minute volume", value: ScreenFormat.money(token.volume5mUsd))
                        if let progress = token.bondingPct { MetricRow(title: "Reported bonding progress", value: DisplayFormat.percent(progress)) }
                        Text(token.mint.description).font(.caption2.monospaced()).foregroundStyle(BotTheme.muted).textSelection(.enabled)
                    }.botCard()
                }.padding(16)
            }.background(BotTheme.background)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Close", systemImage: "xmark") { dismiss() } } }
                .safeAreaInset(edge: .bottom) { dock }
                .overlay(alignment: .top) {
                    if let message = model.notice {
                        Text(message).font(.subheadline.weight(.semibold)).padding(14).background(BotTheme.card, in: RoundedRectangle(cornerRadius: 16))
                            .padding(16).allowsHitTesting(false)
                    }
                }
                .task(id: token.mint) {
                    while !Task.isCancelled {
                        if model.isReady { try? await model.client.requestChart(token.mint) }
                        do { try await Task.sleep(for: .seconds(15)) } catch { return }
                    }
                }
        }.tint(BotTheme.positive).presentationDetents([.large]).presentationDragIndicator(.visible)
    }
    @ViewBuilder private var dock: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let position {
                HStack {
                    Text("Sell your holding").font(.headline)
                    Spacer(); Text(position.quantityText).font(.caption).foregroundStyle(BotTheme.muted)
                }
                HStack {
                    ForEach([2500, 5000, 10000], id: \.self) { bps in
                        Button("Sell \(bps / 100)%") { Haptics.shared.tap(); Task { await model.sell(position, bps: bps) } }
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }.buttonStyle(.bordered).tint(BotTheme.negative).disabled(!model.isReady || model.client.hasPendingFinancialAction)
            } else {
                let options = model.portfolio.map { BuySizing.choices(maximum: $0.maxAffordableBuyLamports.normal, reference: $0.reference, now: model.serverNow) } ?? []
                let chosen = options.first { $0.text == selection } ?? options.first
                let blocked = BuySizing.blockReason(token: token, portfolio: model.portfolio, isFresh: model.isReady, now: model.serverNow)
                HStack {
                    Text("Buy with SOL").font(.headline)
                    Spacer()
                    Button("MAX") { selection = options.last?.text; Haptics.shared.tap() }.font(.caption.weight(.bold)).frame(minWidth: 44, minHeight: 44).disabled(options.isEmpty)
                }
                AmountChoices(choices: options, selection: $selection)
                Button {
                    guard let chosen else { return }; Haptics.shared.tap(); Task { await model.buy(token, amount: chosen) }
                } label: {
                    Text(chosen.map { (model.mode == .paper ? "Paper buy · " : "Buy · ") + $0.lamports.formatted() + " SOL" } ?? "Buy unavailable")
                }.buttonStyle(BotActionStyle()).disabled(blocked != nil || chosen == nil || model.client.hasPendingFinancialAction)
                Text(blocked ?? "MAX is the permitted order ceiling. Fees, token checks and current quotes are validated by the bot.").font(.caption2).foregroundStyle(BotTheme.muted)
            }
        }.padding(16).background(.ultraThinMaterial)
    }
}

private struct SafetyDetails: View {
    let model: TradingAppModel
    let token: FeedToken
    @State private var expanded = false
    private var report: SafetyReport? {
        guard let value = model.client.charts[token.mint]?.safety, value.mint == token.mint, model.serverNow < value.expiresAt else { return nil }
        return value
    }
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 10) {
                if let report {
                    ForEach(report.checks, id: \.key) { check in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: check.status == "pass" ? "checkmark.circle.fill" : check.status == "fail" ? "xmark.circle.fill" : "questionmark.circle")
                                .foregroundStyle(check.status == "pass" ? BotTheme.positive : BotTheme.warning)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(check.key).font(.caption.weight(.semibold))
                                Text(check.detail).font(.caption2).foregroundStyle(BotTheme.muted)
                            }
                        }
                    }
                } else { Text("Current detailed evidence is unavailable. Missing checks stay unverified.").font(.caption).foregroundStyle(BotTheme.muted) }
                Text(token.riskReason).font(.caption).foregroundStyle(BotTheme.muted)
            }.padding(.top, 12)
        } label: {
            Label(token.checkLabel(serverNow: model.serverNow), systemImage: token.checkLabel(serverNow: model.serverNow) == "Checks passed" ? "checkmark.seal" : "exclamationmark.shield")
                .font(.subheadline.weight(.semibold)).foregroundStyle(token.checkLabel(serverNow: model.serverNow) == "Checks passed" ? BotTheme.positive : BotTheme.warning)
        }.botCard()
    }
}
#endif
