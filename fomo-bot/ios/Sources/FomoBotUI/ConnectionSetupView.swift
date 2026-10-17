#if canImport(SwiftUI) && os(iOS)
import SwiftUI
import FomoBotCore

public struct ConnectionSetupView: View {
    let model: TradingAppModel
    @State private var target: TradingMode
    @State private var address = ""
    @State private var token = ""
    @State private var saving = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    public init(model: TradingAppModel) { self.model = model; _target = State(initialValue: model.mode) }
    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Profile", selection: $target) {
                        Text("Paper trading").tag(TradingMode.paper)
                        Text("Real trading").tag(TradingMode.live)
                    }.pickerStyle(.segmented)
                    Text(target == .paper ? "Virtual funds. The backend must report paper mode." : "Real funds. The backend must already be configured locally for live trading.")
                        .font(.subheadline).foregroundStyle(BotTheme.muted)
                }
                Section("Laptop connection") {
                    TextField("https://your-private-backend", text: $address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Controller access token", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                    Text("Use the trusted HTTPS endpoint for this profile and its controller token. The token is stored in Keychain.").font(.caption)
                }
                if let error { Section { Text(error).foregroundStyle(BotTheme.warning) } }
                Section {
                    Button { save() } label: {
                        HStack { Text("Save and connect"); Spacer(); if saving { ProgressView() } }
                    }.disabled(address.isEmpty || token.isEmpty || saving)
                    if !model.endpointText(for: target).isEmpty {
                        Button("Reconnect saved profile") {
                            let selected = target
                            Task { if selected != model.mode { await model.selectMode(selected) } else { await model.connectConfigured() }; dismiss() }
                        }
                    }
                    Button("Disconnect", role: .destructive) { Task { await model.disconnect(); dismiss() } }
                }
                let unresolved = model.client.commands.filter { $0.isUnresolved && $0.endpointIdentity == model.client.endpointIdentity }
                if !unresolved.isEmpty {
                    Section("Saved actions needing review") {
                        ForEach(unresolved) { command in
                            VStack(alignment: .leading, spacing: 5) {
                                Text((command.mode == .paper ? "Paper" : "Real") + " · " + ScreenFormat.short(command.wallet)).font(.caption.weight(.semibold))
                                Text(command.id).font(.caption.monospaced()).textSelection(.enabled)
                                Text(command.reviewReason ?? command.remote?.stage.display ?? "Delivery unresolved").font(.caption2)
                            }
                        }
                    }
                }
                Section {
                    Text("Paper and Real use separate endpoints. The phone cannot unlock a wallet, fund it or change the backend's trading mode.")
                    Text("The laptop must stay awake and connected for protective exits. Closing this app does not stop the laptop.")
                }.font(.caption).foregroundStyle(BotTheme.muted)
            }.disabled(saving).navigationTitle("Connect your bot")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { token = ""; dismiss() }.disabled(saving) } }
                .onAppear { address = model.endpointText(for: target) }
                .onChange(of: target) { _, mode in address = model.endpointText(for: mode); token = ""; error = nil }
                .interactiveDismissDisabled(saving)
        }.tint(BotTheme.positive)
    }
    private func save() {
        let selected = target, input = address, credential = token
        saving = true; error = nil
        Task {
            do {
                try await model.saveConnection(address: input, token: credential, for: selected)
                if selected != model.mode { await model.selectMode(selected) }
                token = ""; saving = false; dismiss()
            } catch ConnectionSetupError.separateEndpointsRequired { error = "Use a different endpoint for Paper and Real trading."; saving = false }
            catch ModelError.invalidEndpoint { error = "Enter a trusted HTTPS endpoint without a query, password or extra path."; saving = false }
            catch ModelError.invalidToken { error = "Enter the controller token generated on your laptop."; saving = false }
            catch { self.error = "The connection could not be saved securely. Check the token and try again."; saving = false }
        }
    }
}
#endif
