#if canImport(SwiftUI) && os(iOS)
import SwiftUI
import FomoBotCore

public struct CopyTradingView: View {
    let model: TradingAppModel
    public init(model: TradingAppModel) { self.model = model }
    public var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 16) {
                    SectionTitle(title: "Copy a wallet", detail: "Choose the environment before changing its copy controls.")
                    Picker("Copy trading environment", selection: Binding(get: { model.mode }, set: { target in Task { await model.selectMode(target) } })) {
                        Text("Paper · virtual funds").tag(TradingMode.paper)
                        Text("Real funds").tag(TradingMode.live)
                    }.pickerStyle(.segmented)
                    if let p = model.portfolio {
                        CopyStatusCard(model: model)
                        VStack(spacing: 12) {
                            MetricRow(title: "Copy allocation", value: "\(p.allocations.copy.pct)%")
                            MetricRow(title: "Copy cash", value: p.allocations.copy.cashLamports.formatted() + " SOL")
                            MetricRow(title: "Copy holdings", value: "\(p.positions.filter { $0.bucket == .copy }.count)")
                            if let halt = p.allocations.copy.halt { Text(halt).font(.caption).foregroundStyle(BotTheme.warning) }
                        }.botCard()
                        AutoPilotCard(model: model)
                        SectionTitle(title: "Copied positions", detail: "Your own stop, profit and time exits remain active.")
                        let holdings = p.positions.filter { $0.bucket == .copy }
                        if holdings.isEmpty { EmptyCard(title: "No copied holdings", detail: "Eligible future leader swaps can be followed when copy trading and automatic entries are both enabled.", symbol: "person.2") }
                        ForEach(holdings) { PositionCard(model: model, position: $0) }
                        PendingTrades(model: model)
                        AllocationCard(model: model)
                        ActivityCard(model: model)
                    } else {
                        EmptyCard(title: "Connect " + (model.mode == .paper ? "Paper" : "Real") + " trading", detail: "Copy trading uses the selected profile's funds and ledger.", symbol: "person.2.badge.gearshape")
                        Button("Set up this profile") { model.needsConnection = true }.buttonStyle(BotActionStyle())
                    }
                }.padding(16)
            }.background(BotTheme.background).navigationTitle("Copy trading")
                .refreshable { try? await model.client.requestSnapshot() }
        }.tint(BotTheme.positive)
    }
}

struct CopyStatusCard: View {
    let model: TradingAppModel
    private var status: String {
        guard let p = model.portfolio else { return "Unavailable" }
        if !model.isReady { return "Connection needed" }
        if let reason = p.copy.blocked { return reason }
        if p.copy.leader == nil { return "No leader configured" }
        if !p.settings.copyEnabled { return "Copy entries disabled" }
        if !p.settings.autoPilot { return "Automatic entries off" }
        if p.settings.paused || p.settings.panic { return "Entries paused" }
        if let halt = p.halt ?? p.allocations.copy.halt { return halt }
        guard let at = p.copy.lastPollAt, model.serverNow >= at - 1000, model.serverNow - at < 120000 else { return "Waiting for current leader history" }
        return p.copy.streamReady ? "Watching verified swaps" : "History polling · stream unavailable"
    }
    var body: some View {
        if let p = model.portfolio {
            VStack(alignment: .leading, spacing: 12) {
                HStack { SectionTitle(title: "Copy status"); ModeBadge(p.mode) }
                Text(status).font(.subheadline.weight(.semibold)).foregroundStyle(BotTheme.warning)
                if let leader = p.copy.leader {
                    Text(leader.description).font(.caption.monospaced()).textSelection(.enabled)
                    MetricRow(title: "Last history check", value: ScreenFormat.time(p.copy.lastPollAt))
                    MetricRow(title: "Last supported signal", value: ScreenFormat.time(p.copy.lastSignalAt))
                } else { Text("Set the public leader address on your laptop.").font(.caption).foregroundStyle(BotTheme.muted) }
                Text("Copies future supported swaps after verification. Your fills and returns can differ from the leader's.").font(.caption2).foregroundStyle(BotTheme.muted)
            }.botCard()
        }
    }
}
#endif
