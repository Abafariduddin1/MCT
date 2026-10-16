import Foundation

public enum ModelError: Error, Equatable, Sendable {
    case invalidAmount, invalidMint, invalidCommand, invalidEndpoint, invalidToken
    case unsupportedProtocol, malformedFrame, oversizedFrame, journalFull, corruptJournal
}

/// Protocol quantities never pass through a floating-point number.
public struct RawAmount: Codable, Hashable, Sendable, CustomStringConvertible {
    public let description: String
    public init(_ value: String) throws {
        let digits = value.hasPrefix("-") ? String(value.dropFirst()) : value
        guard !digits.isEmpty, digits.count <= 25, digits.allSatisfy({ $0 >= "0" && $0 <= "9" }),
              digits == "0" || !digits.hasPrefix("0"), value != "-0" else { throw ModelError.invalidAmount }
        description = value
    }
    public init(from decoder: Decoder) throws { try self.init(decoder.singleValueContainer().decode(String.self)) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(description) }
    public var isNegative: Bool { description.hasPrefix("-") }
    public var isZero: Bool { description == "0" }
    public var decimal: Decimal { Decimal(string: description, locale: Locale(identifier: "en_US_POSIX"))! }
    public func units(decimals: Int) -> Decimal {
        precondition((0...18).contains(decimals))
        var divisor = Decimal(1)
        for _ in 0..<decimals { divisor *= 10 }
        return decimal / divisor
    }
    public func formatted(decimals: Int = 9, maximumFractionDigits: Int = 6, includePlus: Bool = false) -> String {
        guard (0...18).contains(decimals) else { return "—" }
        let precision = max(0, min(maximumFractionDigits, decimals))
        var digits = isNegative ? String(description.dropFirst()) : description
        if digits.count <= decimals { digits = String(repeating: "0", count: decimals + 1 - digits.count) + digits }
        let split = digits.index(digits.endIndex, offsetBy: -decimals)
        let whole = String(digits[..<split])
        var fraction = String(digits[split...].prefix(precision))
        while fraction.last == "0" { fraction.removeLast() }
        let prefix = isNegative ? "−" : includePlus && !isZero ? "+" : ""
        if !isZero && whole == "0" && fraction.isEmpty {
            return prefix + "<" + (precision == 0 ? "1" : "0." + String(repeating: "0", count: precision - 1) + "1")
        }
        return prefix + whole + (fraction.isEmpty ? "" : "." + fraction)
    }
}

public struct SolAmount: Codable, Hashable, Sendable {
    public let text: String
    public let lamports: RawAmount
    public init(_ text: String) throws {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...2).contains(parts.count), let whole = parts.first, !whole.isEmpty, whole.count <= 4,
              whole.allSatisfy({ $0 >= "0" && $0 <= "9" }), whole == "0" || !whole.hasPrefix("0") else { throw ModelError.invalidAmount }
        let fraction = parts.count == 2 ? String(parts[1]) : ""
        guard parts.count == 1 || (!fraction.isEmpty && fraction.count <= 9 && fraction.allSatisfy({ $0 >= "0" && $0 <= "9" })) else { throw ModelError.invalidAmount }
        let raw = String(whole) + fraction + String(repeating: "0", count: 9 - fraction.count)
        let normalized = String(raw.drop(while: { $0 == "0" }))
        let amount = try RawAmount(normalized.isEmpty ? "0" : normalized)
        guard !amount.isZero else { throw ModelError.invalidAmount }
        self.text = text; self.lamports = amount
    }
    public init(from decoder: Decoder) throws { try self.init(decoder.singleValueContainer().decode(String.self)) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(text) }
}

public struct MintAddress: Codable, Hashable, Sendable, CustomStringConvertible {
    public let description: String
    public init(_ value: String) throws {
        let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
        guard (32...44).contains(value.count) else { throw ModelError.invalidMint }
        var bytes: [UInt8] = [0]
        for character in value {
            guard let index = alphabet.firstIndex(of: character) else { throw ModelError.invalidMint }
            var carry = index
            for i in bytes.indices { carry += Int(bytes[i]) * 58; bytes[i] = UInt8(carry & 255); carry >>= 8 }
            while carry > 0 { bytes.append(UInt8(carry & 255)); carry >>= 8 }
        }
        while bytes.last == 0 && bytes.count > 1 { bytes.removeLast() }
        let leadingZeroes = value.prefix(while: { $0 == "1" }).count
        let nonzeroBytes = bytes == [0] ? 0 : bytes.count
        guard leadingZeroes + nonzeroBytes == 32 else { throw ModelError.invalidMint }
        description = value
    }
    public init(from decoder: Decoder) throws { try self.init(decoder.singleValueContainer().decode(String.self)) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(description) }
}

public enum DisplayFormat {
    public static func marketCap(_ value: Double?, locale: Locale = .current) -> String {
        guard let value, value.isFinite, value >= 0 else { return "—" }
        let scale: (Double, String) = value >= 1e12 ? (1e12, "T") : value >= 1e9 ? (1e9, "B") : value >= 1e6 ? (1e6, "M") : value >= 1e3 ? (1e3, "K") : (1, "")
        let format = NumberFormatter(); format.locale = locale; format.numberStyle = .decimal
        format.maximumFractionDigits = scale.0 == 1 ? 0 : 2; format.minimumFractionDigits = 0
        return "$" + (format.string(from: NSNumber(value: value / scale.0)) ?? "—") + scale.1
    }
    public static func percent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return String(format: "%@%.2f%%", locale: Locale(identifier: "en_US_POSIX"), value > 0 ? "+" : "", value)
    }
}
