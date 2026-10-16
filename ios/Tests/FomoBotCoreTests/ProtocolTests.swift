import XCTest
@testable import FomoBotCore

struct ProtocolFixtures {
    static var frames: [String: Data] {
        let url = Bundle.module.url(forResource: "protocol-v1", withExtension: "json", subdirectory: "Fixtures")!
        let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        return (root["frames"] as! [String: Any]).mapValues { try! JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
    }
    static func command(id: String, stage: String = "finalized") -> CommandRecord {
        CommandRecord(id: id, hash: String(repeating: "a", count: 64), type: "QUICK_TRADE", at: 1, stage: RemoteStage(rawValue: stage), reason: nil, orderId: nil)
    }
}
final class ProtocolTests: XCTestCase {
    func testAllRealServerFramesDecode() throws {
        for (name, bytes) in ProtocolFixtures.frames { XCTAssertNoThrow(try ServerMessage.decode(bytes), name) }
        guard case .portfolio(let initial) = try ServerMessage.decode(ProtocolFixtures.frames["initial"]!), case .portfolio(let held) = try ServerMessage.decode(ProtocolFixtures.frames["position"]!) else { return XCTFail("Missing state") }
        XCTAssertEqual(initial.data.mode, .paper); XCTAssertEqual(initial.data.cashLamports.description, "2000000000")
        XCTAssertEqual(held.data.positions.count, 1); XCTAssertNil(held.data.positions[0].estimatedPnlLamports); XCTAssertTrue(held.data.positions[0].markStale)
    }
    func testNullFeedAndChartRemainUnknown() throws {
        guard case .feed(let feed) = try ServerMessage.decode(ProtocolFixtures.frames["feed"]!), case .chart(let chart) = try ServerMessage.decode(ProtocolFixtures.frames["chart"]!) else { return XCTFail("Missing fixtures") }
        XCTAssertNil(feed.data.tokens[0].mcapUsd); XCTAssertNil(feed.data.tokens[0].bondingPct)
        XCTAssertEqual(feed.data.tokens[0].checkLabel(serverNow: feed.at), "Not verified"); XCTAssertTrue(chart.data.points.isEmpty)
    }
    func testOnlyActualFillReceiptCreatesFillLabel() throws {
        guard case .alert(let alert) = try ServerMessage.decode(ProtocolFixtures.frames["alert"]!), case .command(let ack) = try ServerMessage.decode(ProtocolFixtures.frames["ack"]!) else { return XCTFail("Missing fixtures") }
        XCTAssertTrue(alert.data.isFill); XCTAssertEqual(alert.data.display, "Paper fill")
        XCTAssertNotEqual(ack.data.stage.display, "Paper fill")
        XCTAssertFalse(RemoteStage(rawValue: "a_future_unknown_status").isTerminal)
        XCTAssertEqual(RemoteStage(rawValue: "unknown").display, "Outcome unknown")
    }
    func testRejectsUnsupportedVersionAndRawNumbers() throws {
        var frame = try JSONSerialization.jsonObject(with: ProtocolFixtures.frames["initial"]!) as! [String: Any]
        frame["v"] = 2; XCTAssertThrowsError(try ServerMessage.decode(JSONSerialization.data(withJSONObject: frame)))
        frame["v"] = 1; var data = frame["data"] as! [String: Any]; data["cashLamports"] = 2000000000; frame["data"] = data
        XCTAssertThrowsError(try ServerMessage.decode(JSONSerialization.data(withJSONObject: frame)))
        XCTAssertThrowsError(try ServerMessage.decode(Data(repeating: 32, count: 1_000_001)))
    }
    func testDetectsInconsistentAllocationBalances() throws {
        var frame = try JSONSerialization.jsonObject(with: ProtocolFixtures.frames["initial"]!) as! [String: Any]
        var data = frame["data"] as! [String: Any]; data["cashLamports"] = "1"; frame["data"] = data
        XCTAssertThrowsError(try ServerMessage.decode(JSONSerialization.data(withJSONObject: frame)))
    }
    func testUnknownFrameIsIgnoredWithoutLosingSequence() throws {
        let data = Data(#"{"v":1,"type":"FUTURE_READ_ONLY_MESSAGE","seq":88,"at":1,"ledgerSeq":0,"data":{}}"#.utf8)
        guard case .unknown(let type, let sequence) = try ServerMessage.decode(data) else { return XCTFail("Unknown frame must remain ignorable") }
        XCTAssertEqual(type, "FUTURE_READ_ONLY_MESSAGE"); XCTAssertEqual(sequence, 88)
    }
    func testCommandEncodingMatchesStrictFlatServerSchema() throws {
        let mint = try MintAddress("So11111111111111111111111111111111111111112")
        let command = try CommandEnvelope(id: "command_test_000001", payload: .buy(mint: mint, amount: SolAmount("0.000000001")))
        let object = try JSONSerialization.jsonObject(with: command.data()) as! [String: Any]
        XCTAssertEqual(Set(object.keys), Set(["v", "id", "type", "side", "mint", "amountSol"]))
        XCTAssertEqual(object["amountSol"] as? String, "0.000000001"); XCTAssertEqual(object["v"] as? Int, 1)
        XCTAssertEqual(try JSONDecoder().decode(CommandEnvelope.self, from: command.data()), command)
        XCTAssertThrowsError(try CommandEnvelope(payload: .sell(mint: mint, percentBps: 0)))
        XCTAssertThrowsError(try CommandEnvelope(payload: .allocations(normal: 60, copy: 30, reserve: 20)))
    }
    func testRecordedPerformanceIsPaperAndDoesNotInflatePartialWins() throws {
        guard case .performance(let report) = try ServerMessage.decode(ProtocolFixtures.frames["performance"]!) else { return XCTFail("Missing report") }
        XCTAssertEqual(report.data.mode, .paper); XCTAssertEqual(report.data.source, "recorded receipts")
        XCTAssertEqual(report.data.strategies[0].closedTrades, 1); XCTAssertEqual(report.data.strategies[0].entries, 1)
    }
}
final class EndpointTests: XCTestCase {
    private let token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLM"
    func testEndpointNormalizationAndSecretIsolation() throws {
        let endpoint = try BackendEndpoint("wss://example.test:8787/stream")
        XCTAssertEqual(endpoint.identity, "https://example.test:8787/"); XCTAssertEqual(endpoint.socketURL.absoluteString, "wss://example.test:8787/stream")
        let request = try endpoint.authenticatedRequest(url: endpoint.socketURL, token: token)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + token)
        XCTAssertThrowsError(try endpoint.authenticatedRequest(url: URL(string: "https://another.test/image")!, token: token))
        let avatar = AvatarRequest.make("https://ipfs.io/ipfs/example")!
        XCTAssertNil(avatar.value(forHTTPHeaderField: "Authorization"))
    }
    func testRejectsUnsafeEndpointForms() {
        for address in ["http://example.test", "ws://example.test/stream", "https://name:password@example.test", "https://example.test?token=secret", "https://example.test#token", "https://example.test/other", "http://127.0.0.1:8787"] { XCTAssertThrowsError(try BackendEndpoint(address), address) }
        XCTAssertNoThrow(try BackendEndpoint("ws://127.0.0.1:8787/stream", allowInsecureLoopback: true))
        XCTAssertThrowsError(try BackendEndpoint("http://192.168.1.2:8787", allowInsecureLoopback: true))
        XCTAssertNil(AvatarRequest.make("https://evil.test/image")); XCTAssertNil(AvatarRequest.make("http://ipfs.io/example"))
    }
    func testPersistedEndpointValidationCannotBeBypassed() throws {
        let data = Data(#"{"identity":"http://evil.test/","allowsInsecureLoopback":true}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(BackendEndpoint.self, from: data))
    }
}
final class ChartTests: XCTestCase {
    func testTimeUsesRealObservationTimesAndLeavesGaps() {
        let s = ObservedSeries([.init(at: 1000, mcapUsd: 10), .init(at: 11000, mcapUsd: 20), .init(at: 121000, mcapUsd: 30)])
        XCTAssertEqual(s.segments().count, 2); XCTAssertEqual(s.normalized(s.points[1]).x, 1.0 / 12.0, accuracy: 0.00001)
        XCTAssertEqual(s.nearest(to: 8000)?.at, 11000); XCTAssertEqual(s.nearest(to: -1)?.at, 1000)
    }
    func testCleansInvalidDuplicateAndUnboundedHistory() {
        let values = (0..<700).map { MarketPoint(at: Int64($0 * 10000), mcapUsd: Double($0)) }
        let s = ObservedSeries(values + [.init(at: -1, mcapUsd: 1), .init(at: 6990000, mcapUsd: 999), .init(at: 7000000, mcapUsd: .nan)])
        XCTAssertEqual(s.points.count, 512); XCTAssertEqual(s.points.last?.mcapUsd, 999)
        XCTAssertEqual(ObservedSeries([.init(at: 1, mcapUsd: 10), .init(at: 2, mcapUsd: 10)]).normalized(.init(at: 1, mcapUsd: 10)).y, 0.5)
    }
    func testTimeframesNeedActualCoverageAndStalenessIsExplicit() {
        let s = ObservedSeries([.init(at: 1000, mcapUsd: 10), .init(at: 11000, mcapUsd: 11)])
        XCTAssertFalse(s.isAvailable(.minute, now: 11000)); XCTAssertTrue(s.isAvailable(.all, now: 11000))
        XCTAssertFalse(s.isStale(now: 12000)); XCTAssertTrue(s.isStale(now: 50000)); XCTAssertTrue(s.visible(.minute, now: 200000).points.isEmpty)
    }
}
final class CrossLanguageCommandTests: XCTestCase {
    func testEveryMutationEncodesForTheActualServerValidator() throws {
        guard case .feed(let feed) = try ServerMessage.decode(ProtocolFixtures.frames["feed"]!) else { return XCTFail("Missing mint fixture") }
        let mint = feed.data.tokens[0].mint, amount = try SolAmount("0.05")
        let payloads: [CommandPayload] = [.buy(mint: mint, amount: amount), .sell(mint: mint, percentBps: 5000), .preset(.safe, autoPilot: false, normalEnabled: true, copyEnabled: false, amount: amount), .allocations(normal: 50, copy: 30, reserve: 20), .pause(true), .panic]
        var values: [[String: Any]] = []
        for (index, payload) in payloads.enumerated() {
            let envelope = try CommandEnvelope(id: "swift_codec_command_000" + String(index), payload: payload)
            let data = try envelope.data(); XCTAssertEqual(try JSONDecoder().decode(CommandEnvelope.self, from: data).payload, payload)
            values.append(try JSONSerialization.jsonObject(with: data) as! [String: Any])
        }
        if let destination = ProcessInfo.processInfo.environment["FOMOBOT_CODEC_OUTPUT"] {
            try JSONSerialization.data(withJSONObject: values, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: destination), options: .atomic)
        }
    }
}
