#if canImport(SwiftUI) && os(iOS)
import SwiftUI
import FomoBotCore

public struct FeedView: View {
    let model: TradingAppModel
    let openToken: (FeedToken) -> Void
    @State private var filter: FeedFilter = .trending
    @State private var search = ""
    public init(model: TradingAppModel, openToken: @escaping (FeedToken) -> Void) { self.model = model; self.openToken = openToken }
    public var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 14) {
                    activity
                    Picker("Feed category", selection: $filter) {
                        ForEach(FeedFilter.allCases) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented).padding(.bottom, 4)
                    if !model.isReady && model.client.feed.isEmpty {
                        EmptyCard(title: "Connect your bot", detail: "Your laptop supplies token data and keeps position protection running.", symbol: "laptopcomputer.and.iphone")
                        Button("Set up connection") { model.needsConnection = true }.buttonStyle(BotActionStyle())
                    } else if visible.isEmpty {
                        EmptyCard(title: search.isEmpty ? "Waiting for observations" : "No matching tokens", detail: filter == .graduating ? "This filter needs reported bonding progress between 85% and 100%." : "Tokens appear when your backend observes them. A listing does not mean it can be bought.")
                    } else {
                        ForEach(visible) { token in TokenFeedRow(model: model, token: token, open: { openToken(token) }) }
                    }
                }.padding(16)
            }.background(BotTheme.background).navigationTitle("Discover")
                .searchable(text: $search, prompt: "Token name, ticker or mint")
                .refreshable { try? await model.client.requestSnapshot() }
        }.tint(BotTheme.positive)
    }
    private var visible: [FeedToken] {
        filter.tokens(model.client.feed, now: model.serverNow).filter {
            search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.symbol.localizedCaseInsensitiveContains(search) || $0.mint.description.localizedCaseInsensitiveContains(search)
        }
    }
    private var activity: some View {
        HStack(spacing: 8) {
            Image(systemName: "waveform.path").foregroundStyle(BotTheme.positive)
            if let event = model.client.tradeAlerts.last, event.isFill {
                let symbol = model.portfolio?.recentOrders.first { $0.id == event.data.orderId }?.symbol ?? "token"
                Text(event.display + " · " + (event.data.side ?? "trade").uppercased() + " " + symbol).lineLimit(2)
            } else { Text("Observed activity · " + (model.mode == .paper ? "virtual funds" : "real funds")) }
            Spacer(minLength: 0)
        }.font(.caption.weight(.medium)).foregroundStyle(BotTheme.muted).padding(12).background(BotTheme.card, in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct TokenFeedRow: View {
    let model: TradingAppModel
    let token: FeedToken
    let open: () -> Void
    private var option: SolAmount? {
        guard let p = model.portfolio else { return nil }
        return BuySizing.choices(maximum: p.maxAffordableBuyLamports.normal, reference: p.reference, now: model.serverNow).first
    }
    private var block: String? { BuySizing.blockReason(token: token, portfolio: model.portfolio, isFresh: model.isReady, now: model.serverNow) }
    var body: some View {
        VStack(spacing: 12) {
            Button(action: open) {
                HStack(spacing: 12) {
                    TokenAvatar(symbol: token.symbol, uri: token.imageUri)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(token.symbol).font(.system(.headline, design: .rounded, weight: .bold)).foregroundStyle(.white)
                        Text(token.name).font(.caption).foregroundStyle(BotTheme.muted).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(DisplayFormat.marketCap(token.mcapUsd)).font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(.white).monospacedDigit()
                        Text(DisplayFormat.percent(token.change5mPct)).font(.caption.weight(.semibold)).foregroundStyle(BotTheme.movement(token.change5mPct))
                    }
                }.frame(minHeight: 48).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityHint("Open token details and observed chart")
            HStack(spacing: 8) {
                let status = token.checkLabel(serverNow: model.serverNow)
                Label(status, systemImage: status == "Checks passed" ? "checkmark.seal.fill" : "exclamationmark.circle")
                    .font(.caption2).foregroundStyle(status == "Checks passed" ? BotTheme.positive : BotTheme.warning)
                Spacer()
                Sparkline(values: token.sparkline).frame(width: 65, height: 22)
            }
            if let progress = token.bondingPct {
                HStack(spacing: 8) {
                    ProgressView(value: progress, total: 100).tint(BotTheme.positive)
                    Text(progress.formatted(.number.precision(.fractionLength(0))) + "%").font(.caption2).foregroundStyle(BotTheme.muted)
                }.accessibilityLabel("Reported bonding progress \(Int(progress)) percent")
            }
            HStack(alignment: .center, spacing: 10) {
                Text(block ?? "Order checked again before execution").font(.caption2).foregroundStyle(BotTheme.muted).lineLimit(2)
                Spacer(minLength: 0)
                Button {
                    guard let option else { return }; Haptics.shared.tap(); Task { await model.buy(token, amount: option) }
                } label: {
                    Text(option.map { "Buy " + $0.lamports.formatted() + " SOL" } ?? "Buy unavailable")
                        .font(.system(.caption, design: .rounded, weight: .bold)).padding(.horizontal, 12).frame(minHeight: 44)
                        .foregroundStyle(block == nil ? Color.black : BotTheme.muted)
                        .background(block == nil ? BotTheme.positive : BotTheme.border, in: Capsule())
                }.buttonStyle(.plain).disabled(block != nil || option == nil || model.client.hasPendingFinancialAction)
            }
        }.botCard()
    }
}
#endif
