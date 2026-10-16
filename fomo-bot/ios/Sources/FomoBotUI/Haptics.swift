import Foundation
#if canImport(UIKit)
import UIKit
#endif

@MainActor public final class Haptics {
    public static let shared = Haptics()
    public var enabled = true
    private var lastSelection: TimeInterval = -1
    private var lastImpact: TimeInterval = -1
    #if canImport(UIKit)
    private let selection = UISelectionFeedbackGenerator()
    private let impact = UIImpactFeedbackGenerator(style: .light)
    private let notification = UINotificationFeedbackGenerator()
    #endif
    public init() {}
    public func prepare() {
        #if canImport(UIKit)
        guard enabled, UIApplication.shared.applicationState == .active else { return }; selection.prepare(); impact.prepare(); notification.prepare()
        #endif
    }
    public func scrub() {
        #if canImport(UIKit)
        let now = ProcessInfo.processInfo.systemUptime
        guard enabled, UIApplication.shared.applicationState == .active, now - lastSelection >= 0.08 else { return }
        lastSelection = now; selection.selectionChanged()
        #endif
    }
    public func tap() {
        #if canImport(UIKit)
        let now = ProcessInfo.processInfo.systemUptime
        guard enabled, UIApplication.shared.applicationState == .active, now - lastImpact >= 0.15 else { return }
        lastImpact = now; impact.impactOccurred(intensity: 0.65)
        #endif
    }
    /// Call after a validated durable fill event, never after a send ACK.
    public func fill() {
        #if canImport(UIKit)
        let now = ProcessInfo.processInfo.systemUptime
        guard enabled, UIApplication.shared.applicationState == .active, now - lastImpact >= 0.3 else { return }
        lastImpact = now; notification.notificationOccurred(.success)
        #endif
    }
}
