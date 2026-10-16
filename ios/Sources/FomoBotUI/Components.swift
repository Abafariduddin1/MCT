#if canImport(SwiftUI)
import SwiftUI
import Foundation
import FomoBotCore
#if canImport(UIKit)
import UIKit
#endif

enum ScreenFormat {
    static func money(_ value: Double?, currency: String = "USD") -> String {
        guard let value, value.isFinite else { return "—" }
        return value.formatted(.currency(code: currency).precision(.fractionLength(2)))
    }
    static func time(_ at: Int64?) -> String {
        guard let at else { return "Not observed" }
        return Date(timeIntervalSince1970: Double(at) / 1000).formatted(date: .omitted, time: .shortened)
    }
    static func short(_ value: String) -> String { value.count > 16 ? String(value.prefix(6)) + "…" + String(value.suffix(5)) : value }
}

struct SectionTitle: View {
    let title: String
    var detail: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(.white)
            if let detail { Text(detail).font(.caption).foregroundStyle(BotTheme.muted) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
struct EmptyCard: View {
    let title: String
    let detail: String
    var symbol = "sparkle.magnifyingglass"
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol).font(.largeTitle).foregroundStyle(BotTheme.muted)
            Text(title).font(.headline)
            Text(detail).font(.subheadline).foregroundStyle(BotTheme.muted).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity).padding(.vertical, 24).botCard()
    }
}
struct MetricRow: View {
    let title: String
    let value: String
    var color: Color = .white
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).foregroundStyle(BotTheme.muted)
            Spacer(minLength: 12)
            Text(value).foregroundStyle(color).monospacedDigit().multilineTextAlignment(.trailing)
        }.font(.subheadline).accessibilityElement(children: .combine)
    }
}
struct ConnectionBanner: View {
    let model: TradingAppModel
    var body: some View {
        TimelineView(.periodic(from: .now, by: 2)) { _ in
            HStack(spacing: 9) {
                Image(systemName: model.isReady ? "wifi" : "wifi.exclamationmark").foregroundStyle(model.isReady ? BotTheme.positive : BotTheme.warning)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.client.connectionState == .ready && !model.isReady ? "Data is stale" : model.client.connectionState.label).font(.caption.weight(.semibold))
                    if let error = model.client.lastError ?? model.setupError { Text(error).font(.caption2).foregroundStyle(BotTheme.muted) }
                }
                Spacer(minLength: 4)
                ModeBadge(model.mode)
            }.accessibilityElement(children: .combine)
        }
    }
}

struct Sparkline: View {
    let values: [Double]
    var body: some View {
        GeometryReader { g in
            let points = values.filter { $0.isFinite && $0 >= 0 }
            if points.count >= 2 {
                Path { path in
                    let low = points.min()!, span = max((points.max() ?? low) - low, 1)
                    for (i, value) in points.enumerated() {
                        let point = CGPoint(x: g.size.width * Double(i) / Double(points.count - 1), y: g.size.height * (0.85 - (value - low) / span * 0.7))
                        if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
                    }
                }.stroke((points.last ?? 0) >= (points.first ?? 0) ? BotTheme.positive : BotTheme.negative, style: StrokeStyle(lineWidth: 1.7, lineCap: .round))
            }
        }.accessibilityHidden(true)
    }
}

private final class ImageRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
private actor AvatarImages {
    static let shared = AvatarImages()
    private var cache: [String: Data] = [:]
    private let session: URLSession
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCache = nil
        config.timeoutIntervalForRequest = 8; config.timeoutIntervalForResource = 10
        session = URLSession(configuration: config, delegate: ImageRedirectDelegate(), delegateQueue: nil)
    }
    func load(_ value: String?) async -> Data? {
        guard let value, let request = AvatarRequest.make(value) else { return nil }
        if let bytes = cache[value] { return bytes }
        do {
            let (stream, response) = try await session.bytes(for: request)
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  response.url == request.url, response.expectedContentLength <= 512000,
                  response.mimeType?.hasPrefix("image/") == true else { return nil }
            var bytes = Data()
            for try await byte in stream { if bytes.count >= 512000 || Task.isCancelled { return nil }; bytes.append(byte) }
            if cache.count >= 100 { cache.removeAll(keepingCapacity: true) }
            cache[value] = bytes; return bytes
        } catch { return nil }
    }
}
struct TokenAvatar: View {
    let symbol: String
    let uri: String?
    var size: CGFloat = 46
    @State private var bytes: Data?
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.3).fill(BotTheme.border)
            #if canImport(UIKit)
            if let bytes, let image = UIImage(data: bytes) { Image(uiImage: image).resizable().scaledToFill() }
            else { fallback }
            #else
            fallback
            #endif
        }.frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: size * 0.3)).accessibilityHidden(true)
            .task(id: uri) { bytes = nil; let fetched = await AvatarImages.shared.load(uri); if !Task.isCancelled { bytes = fetched } }
    }
    private var fallback: some View { Text(String(symbol.prefix(2))).font(.system(.headline, design: .rounded, weight: .bold)).foregroundStyle(.white) }
}

struct AmountChoices: View {
    let choices: [SolAmount]
    @Binding var selection: String?
    var onSelect: ((SolAmount) -> Void)? = nil
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { pills }
            VStack(alignment: .leading, spacing: 6) { pills }
        }
    }
    @ViewBuilder private var pills: some View {
        ForEach(choices, id: \.text) { amount in
            Button { selection = amount.text; Haptics.shared.tap(); onSelect?(amount) } label: {
                Text(amount.lamports.formatted(maximumFractionDigits: 6) + " SOL")
                    .font(.system(.caption, design: .rounded, weight: .semibold)).monospacedDigit()
                    .padding(.horizontal, 10).frame(minHeight: 44)
                    .foregroundStyle(selected(amount) ? Color.black : Color.white)
                    .background(selected(amount) ? BotTheme.positive : BotTheme.border, in: Capsule())
            }.buttonStyle(.plain).accessibilityAddTraits(selected(amount) ? .isSelected : [])
                .accessibilityLabel(amount.text + " SOL" + (amount == choices.last ? ", maximum permitted ceiling" : ""))
        }
    }
    private func selected(_ amount: SolAmount) -> Bool { amount.text == selection || selection == nil && amount == choices.first }
}
#endif
