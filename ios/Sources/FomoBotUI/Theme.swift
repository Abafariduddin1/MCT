#if canImport(SwiftUI)
import SwiftUI
import FomoBotCore

public enum BotTheme {
    public static let background = Color(red: 0, green: 0, blue: 0)
    public static let card = Color(red: 17 / 255, green: 18 / 255, blue: 22 / 255)
    public static let border = Color(red: 31 / 255, green: 33 / 255, blue: 40 / 255)
    public static let positive = Color(red: 0, green: 1, blue: 102 / 255)
    public static let negative = Color(red: 1, green: 46 / 255, blue: 84 / 255)
    public static let muted = Color(red: 149 / 255, green: 153 / 255, blue: 168 / 255)
    public static let warning = Color(red: 1, green: 0.76, blue: 0.28)
    public static let cornerRadius: CGFloat = 20
    public static func numberFont(_ style: Font.TextStyle = .largeTitle) -> Font { .system(style, design: .rounded, weight: .bold) }
    public static func movement(_ value: Double?) -> Color {
        guard let value, value.isFinite else { return muted }; return value < 0 ? negative : value > 0 ? positive : .white
    }
}
public struct CardSurface: ViewModifier {
    public init() {}
    public func body(content: Content) -> some View {
        content.padding(16).background(BotTheme.card, in: RoundedRectangle(cornerRadius: BotTheme.cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: BotTheme.cornerRadius).stroke(BotTheme.border, lineWidth: 1))
    }
}
public extension View { func botCard() -> some View { modifier(CardSurface()) } }
public struct StatusPill: View {
    public let title: String; public let symbol: String; public let color: Color
    public init(_ title: String, symbol: String, color: Color = BotTheme.muted) { self.title = title; self.symbol = symbol; self.color = color }
    public var body: some View {
        Label(title, systemImage: symbol).font(.system(.caption, design: .rounded, weight: .semibold))
            .foregroundStyle(color).padding(.horizontal, 10).padding(.vertical, 7)
            .background(color.opacity(0.12), in: Capsule()).accessibilityElement(children: .combine)
    }
}
public struct ModeBadge: View {
    public let mode: TradingMode
    public init(_ mode: TradingMode) { self.mode = mode }
    public var body: some View { StatusPill(mode == .paper ? "Paper · simulated" : "Live", symbol: mode == .paper ? "testtube.2" : "dot.radiowaves.left.and.right", color: mode == .paper ? BotTheme.warning : .white) }
}
public struct NativeAmountLabel: View {
    public let amount: RawAmount?; public let isStale: Bool; public let signed: Bool
    public init(_ amount: RawAmount?, isStale: Bool = false, signed: Bool = false) { self.amount = amount; self.isStale = isStale; self.signed = signed }
    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(isStale ? "—" : amount?.formatted(includePlus: signed) ?? "—").font(BotTheme.numberFont()).monospacedDigit()
            Text("SOL").font(.system(.subheadline, design: .rounded, weight: .semibold)).foregroundStyle(BotTheme.muted)
        }.accessibilityLabel(isStale ? "SOL value unavailable or stale" : (amount?.formatted(includePlus: signed) ?? "Unavailable") + " SOL")
    }
}
public struct BotActionStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(.headline, design: .rounded, weight: .bold)).frame(minHeight: 48).frame(maxWidth: .infinity)
            .foregroundStyle(enabled ? Color.black : BotTheme.muted)
            .background(enabled ? BotTheme.positive : BotTheme.border, in: RoundedRectangle(cornerRadius: 16))
            .opacity(configuration.isPressed ? 0.8 : 1).scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
    }
}
#endif
