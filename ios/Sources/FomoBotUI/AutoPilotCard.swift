#if canImport(SwiftUI) && os(iOS)
import SwiftUI
import FomoBotCore

struct AutoPilotCard: View {
    let model: TradingAppModel
    private var busy: Bool { model.activeCommands.contains { $0.envelope.payload.wireType == "SET_BOT_PRESET" && $0.isUnresolved } }
    var body: some View {
        if let p = model.portfolio {
            VStack(alignment: .leading, spacing: 16) {
                SectionTitle(title: "Auto-pilot", detail: "The laptop manages entries and protective exits.")
                Toggle("Automatic entries", isOn: Binding(get: { p.settings.autoPilot }, set: { value in Task { await model.updateSettings(autoPilot: value) } }))
                HStack(spacing: 8) {
                    ForEach(BotPreset.allCases, id: \.self) { preset in
                        Button { Haptics.shared.tap(); Task { await model.updateSettings(preset: preset) } } label: {
                            Text(preset.rawValue).font(.system(.subheadline, design: .rounded, weight: .bold))
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .foregroundStyle(p.settings.preset == preset ? Color.black : Color.white)
                                .background(p.settings.preset == preset ? BotTheme.positive : BotTheme.border, in: Capsule())
                        }.buttonStyle(.plain).accessibilityAddTraits(p.settings.preset == preset ? .isSelected : [])
                    }
                }
                let ceiling = p.maxAffordableBuyLamports.normal.decimal > p.maxAffordableBuyLamports.copy.decimal ? p.maxAffordableBuyLamports.normal : p.maxAffordableBuyLamports.copy
                let choices = BuySizing.choices(maximum: ceiling, reference: p.reference, now: model.serverNow)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Requested size · " + p.settings.orderLamports.formatted() + " SOL").font(.caption).foregroundStyle(BotTheme.muted)
                    if !choices.isEmpty {
                        AmountChoices(choices: choices, selection: Binding(get: { p.settings.orderLamports.formatted(maximumFractionDigits: 9) }, set: { _ in }), onSelect: { amount in
                            Task { await model.updateSettings(amount: amount) }
                        })
                    }
                    Text("Automatic orders may be reduced to fit the available allocation.").font(.caption2).foregroundStyle(BotTheme.muted)
                }
                Toggle("Normal strategies", isOn: Binding(get: { p.settings.normalEnabled }, set: { value in Task { await model.updateSettings(normal: value) } }))
                Toggle("Copy trading", isOn: Binding(get: { p.settings.copyEnabled }, set: { value in Task { await model.updateSettings(copy: value) } }))
                    .disabled(p.copy.leader == nil)
                Text(p.settings.preset == .safe ? "At the configured target: sell all." : p.settings.preset == .fast ? "At the configured target: sell 50% once; protect the remainder." : "At the configured target: sell 75% once; protect the remainder.")
                    .font(.caption).foregroundStyle(BotTheme.muted)
                Text("Profile names keep the same spending limits and token checks.").font(.caption2).foregroundStyle(BotTheme.muted)
                Divider().overlay(BotTheme.border)
                Button(p.settings.paused ? "Resume new entries" : "Pause new entries") {
                    Haptics.shared.tap(); Task { await model.send(.pause(!p.settings.paused)) }
                }.buttonStyle(.bordered).controlSize(.large)
                    .disabled(p.settings.panic && (!p.positions.isEmpty || !p.pending.isEmpty))
                Text(p.settings.panic && (!p.positions.isEmpty || !p.pending.isEmpty) ? "Liquidation is active. Resolve the pending or unsold positions before resuming." : "Pausing entries keeps position protection running. Resuming does not clear a loss halt.")
                    .font(.caption2).foregroundStyle(BotTheme.muted)
                if busy { ProgressView("Updating settings…").font(.caption) }
            }.tint(BotTheme.positive).botCard().disabled(!model.isReady || busy)
        }
    }
}

struct AllocationCard: View {
    let model: TradingAppModel
    @State private var editing = false
    var body: some View {
        if let p = model.portfolio {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    SectionTitle(title: "Capital split")
                    Button("Edit") { editing = true }.font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                        .disabled(!model.isReady || p.settings.autoPilot || !p.positions.isEmpty || !p.pending.isEmpty)
                }
                MetricRow(title: "Normal · \(p.allocations.normal.pct)%", value: p.allocations.normal.cashLamports.formatted() + " SOL cash")
                MetricRow(title: "Copy · \(p.allocations.copy.pct)%", value: p.allocations.copy.cashLamports.formatted() + " SOL cash")
                MetricRow(title: "Reserve · \(p.allocations.reserve.pct)%", value: p.allocations.reserve.cashLamports.formatted() + " SOL cash")
                Text("Change the split while flat, with auto-pilot off. Reserve stays in SOL.").font(.caption2).foregroundStyle(BotTheme.muted)
            }.botCard().sheet(isPresented: $editing) { AllocationEditor(model: model, normal: p.allocations.normal.pct, copy: p.allocations.copy.pct) }
        }
    }
}
private struct AllocationEditor: View {
    let model: TradingAppModel
    @State var normal: Int
    @State var copy: Int
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Stepper("Normal: \(normal)%", value: $normal, in: 0...(100 - copy), step: 5)
                Stepper("Copy: \(copy)%", value: $copy, in: 0...(100 - normal), step: 5)
                Text("Reserve: \(100 - normal - copy)%")
                Button("Apply allocation") { Task { await model.send(.allocations(normal: normal, copy: copy, reserve: 100 - normal - copy)); dismiss() } }
                    .disabled(!model.isReady || model.portfolio?.settings.autoPilot != false || model.portfolio?.positions.isEmpty != true || model.portfolio?.pending.isEmpty != true)
            }.navigationTitle("Capital split").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }.presentationDetents([.medium])
    }
}
#endif
