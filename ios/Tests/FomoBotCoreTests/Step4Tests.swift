import XCTest
@testable import FomoBotCore

private let stepToken = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLM"
private actor StepCredentials: CredentialStore {
    var saves = 0
    func token(for endpoint: BackendEndpoint) -> String { stepToken }
    func save(_ token: String, for endpoint: BackendEndpoint) { saves += 1 }
    func remove(for endpoint: BackendEndpoint) {}
}
private actor StepJournal: CommandStore {
    private var rows: [LocalCommand] = []
    func load() -> [LocalCommand] { rows }
    func upsert(_ item: LocalCommand) throws {
        if let i = rows.firstIndex(where: { $0.id == item.id }) { rows[i] = try rows[i].merging(item) } else { rows.append(item) }
    }
}
private actor StepSocket: SocketConnection {
    private var frames: [Data]
    private var waiting: CheckedContinuation<Data, any Error>?
    private var closed = false
    private var sent: [Data] = []
    init(_ frames: [Data]) { self.frames = frames }
    func receive() async throws -> Data {
        if closed { throw TransportError.unavailable }
        if !frames.isEmpty { return frames.removeFirst() }
        return try await withCheckedThrowingContinuation { waiting = $0 }
    }
    func push(_ data: Data) { if let pending = waiting { waiting = nil; pending.resume(returning: data) } else { frames.append(data) } }
    func send(_ data: Data) { sent.append(data) }
    func ping() {}
    func close() { closed = true; waiting?.resume(throwing: TransportError.unavailable); waiting = nil }
    func mutations() -> Int { sent.filter { (try? JSONSerialization.jsonObject(with: $0) as? [String: Any])?["id"] != nil }.count }
}
private actor StepTransport: ControllerTransport {
    private let sockets: [StepSocket]
    private(set) var opens = 0
    init(_ sockets: [StepSocket]) { self.sockets = sockets }
    func open(endpoint: BackendEndpoint, token: String) throws -> any SocketConnection {
        guard opens < sockets.count else { throw TransportError.unavailable }
        defer { opens += 1 }; return sockets[opens]
    }
    func lookup(id: String, endpoint: BackendEndpoint, token: String) -> CommandLookup { .notFound }
}
private func stepFrame(_ name: String, sequence: Int64? = nil, mutate: (inout [String: Any]) -> Void = { _ in }) throws -> Data {
    var frame = try JSONSerialization.jsonObject(with: ProtocolFixtures.frames[name]!) as! [String: Any]
    if let sequence { frame["seq"] = sequence }
    var payload = frame["data"] as! [String: Any]; mutate(&payload); frame["data"] = payload
    return try JSONSerialization.data(withJSONObject: frame)
}
@MainActor private func stepUntil(_ check: () -> Bool) async throws {
    for _ in 0..<150 { if check() { return }; try await Task.sleep(for: .milliseconds(10)) }
    XCTFail("Client did not reach the expected state"); throw TransportError.unavailable
}

final class Step4Tests: XCTestCase {
    @MainActor func testProfilesKeepPaperAndLiveEndpointsSeparateWithoutCredentialsInPreferences() throws {
        let suite = "step4-profiles-" + UUID().uuidString, defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let profiles = TradingProfiles(defaults: defaults), paper = try BackendEndpoint("https://paper.example.test"), live = try BackendEndpoint("https://live.example.test")
        try profiles.save(paper, for: .paper); try profiles.save(live, for: .live)
        XCTAssertEqual(try profiles.endpoint(for: .paper), paper); XCTAssertEqual(try profiles.endpoint(for: .live), live)
        XCTAssertFalse(String(describing: defaults.dictionaryRepresentation()).contains(stepToken))
        try profiles.remove(for: .live); XCTAssertNil(try profiles.endpoint(for: .live)); XCTAssertEqual(try profiles.endpoint(for: .paper), paper)
        defaults.set(Data(#"{"version":2,"endpoints":{}}"#.utf8), forKey: "fomobot.controller.profiles.v1")
        XCTAssertThrowsError(try profiles.endpoint(for: .paper))
    }
    @MainActor func testPaperProfileRejectsALiveServerBeforeReadinessOrMutation() async throws {
        let live = try stepFrame("initial") { $0["mode"] = "live" }
        let socket = StepSocket([live, ProtocolFixtures.frames["feed"]!]), client = BotWebSocketClient(credentials: StepCredentials(), journal: StepJournal(), transport: StepTransport([socket]))
        defer { Task { await client.disconnect() } }
        await client.connect(to: try BackendEndpoint("https://paper.example.test"), expectedMode: .paper)
        try await stepUntil { if case .blocked = client.connectionState { return true }; return false }
        XCTAssertNil(client.portfolio); XCTAssertFalse(client.isFresh)
        do { _ = try await client.send(.panic); XCTFail("A mismatched mode accepted a command") } catch {}
        let mutations = await socket.mutations(); XCTAssertEqual(mutations, 0)
    }
    @MainActor func testLiveProfileRejectsAPaperServer() async throws {
        let socket = StepSocket([ProtocolFixtures.frames["initial"]!]), client = BotWebSocketClient(credentials: StepCredentials(), journal: StepJournal(), transport: StepTransport([socket]))
        await client.connect(to: try BackendEndpoint("https://live.example.test"), expectedMode: .live)
        try await stepUntil { if case .blocked = client.connectionState { return true }; return false }
        XCTAssertNil(client.portfolio); XCTAssertFalse(client.isFresh); await client.disconnect()
    }
    @MainActor func testDisconnectClearsPreviousProfileDataImmediately() async throws {
        let socket = StepSocket([ProtocolFixtures.frames["initial"]!, ProtocolFixtures.frames["feed"]!]), client = BotWebSocketClient(credentials: StepCredentials(), journal: StepJournal(), transport: StepTransport([socket]))
        await client.connect(to: try BackendEndpoint("https://paper.example.test"), expectedMode: .paper)
        try await stepUntil { client.isFresh }; XCTAssertFalse(client.feed.isEmpty)
        await client.disconnect(); XCTAssertNil(client.portfolio); XCTAssertTrue(client.feed.isEmpty); XCTAssertTrue(client.charts.isEmpty); XCTAssertNil(client.performance)
    }
    @MainActor func testCopyTabKeepsPaperEnvironmentAndDoesNotEnableTrading() async throws {
        let suite = "step4-copy-" + UUID().uuidString, defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let profiles = TradingProfiles(defaults: defaults)
        try profiles.save(BackendEndpoint("https://paper.example.test"), for: .paper)
        let socket = StepSocket([ProtocolFixtures.frames["initial"]!, ProtocolFixtures.frames["feed"]!]), transport = StepTransport([socket])
        let model = TradingAppModel(credentials: StepCredentials(), journal: StepJournal(), profiles: profiles, transport: transport)
        await model.start(); try await stepUntil { model.isReady }; await model.select(.copy)
        XCTAssertEqual(model.section, .copy); XCTAssertEqual(model.mode, .paper); XCTAssertEqual(model.portfolio?.settings.autoPilot, false)
        let opens = await transport.opens, mutations = await socket.mutations(); XCTAssertEqual(opens, 1); XCTAssertEqual(mutations, 0)
        await model.selectMode(.live); XCTAssertEqual(model.mode, .live); XCTAssertNil(model.portfolio); XCTAssertTrue(model.client.feed.isEmpty); XCTAssertTrue(model.needsConnection)
        await model.disconnect()
    }
    @MainActor func testSavingSameEndpointForBothModesIsRefusedBeforeChangingCredential() async throws {
        let suite = "step4-duplicate-" + UUID().uuidString, defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let profiles = TradingProfiles(defaults: defaults), credentials = StepCredentials()
        try profiles.save(BackendEndpoint("https://paper.example.test"), for: .paper)
        let model = TradingAppModel(credentials: credentials, journal: StepJournal(), profiles: profiles, transport: StepTransport([]))
        do { try await model.saveConnection(address: "https://paper.example.test/stream", token: stepToken, for: .live); XCTFail("Duplicate profile endpoint accepted") }
        catch { XCTAssertEqual(error as? ConnectionSetupError, .separateEndpointsRequired) }
        let count = await credentials.saves; XCTAssertEqual(count, 0); XCTAssertNil(try profiles.endpoint(for: .live))
    }
    @MainActor func testStaleDisplayClockBlocksActionsWithoutResettingThePortfolio() async throws {
        let suite = "step4-stale-" + UUID().uuidString, defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let profiles = TradingProfiles(defaults: defaults); try profiles.save(BackendEndpoint("https://paper.example.test"), for: .paper)
        let socket = StepSocket([ProtocolFixtures.frames["initial"]!, ProtocolFixtures.frames["feed"]!])
        let model = TradingAppModel(credentials: StepCredentials(), journal: StepJournal(), profiles: profiles, transport: StepTransport([socket]))
        await model.start(); try await stepUntil { model.isReady }; let cash = model.portfolio?.cashLamports
        model.refreshClock(at: .now.addingTimeInterval(11)); XCTAssertFalse(model.isReady)
        await model.send(.panic); let mutations = await socket.mutations(); XCTAssertEqual(mutations, 0)
        XCTAssertEqual(model.portfolio?.cashLamports, cash); await model.disconnect()
    }
    @MainActor func testChangingEnvironmentOutsideCopyKeepsTheSelectedTabConsistent() async throws {
        let suite = "step4-mode-label-" + UUID().uuidString, defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = TradingAppModel(credentials: StepCredentials(), journal: StepJournal(), profiles: TradingProfiles(defaults: defaults), transport: StepTransport([]))
        await model.selectMode(.live); XCTAssertEqual(model.mode, .live); XCTAssertEqual(model.section, .live)
        await model.select(.copy); await model.selectMode(.paper); XCTAssertEqual(model.mode, .paper); XCTAssertEqual(model.section, .copy)
        await model.select(.paper); XCTAssertEqual(model.section, .paper); XCTAssertEqual(model.mode, .paper)
        await model.disconnect()
    }
    @MainActor func testWalletChangeInsideAConnectionBlocksFurtherCommands() async throws {
        let socket = StepSocket([ProtocolFixtures.frames["initial"]!, ProtocolFixtures.frames["feed"]!]), client = BotWebSocketClient(credentials: StepCredentials(), journal: StepJournal(), transport: StepTransport([socket]))
        await client.connect(to: try BackendEndpoint("https://paper.example.test"), expectedMode: .paper)
        try await stepUntil { client.isFresh }
        await socket.push(try stepFrame("initial", sequence: 20) { $0["wallet"] = "changed-wallet" })
        try await stepUntil { if case .blocked = client.connectionState { return true }; return false }
        XCTAssertFalse(client.isFresh); await client.disconnect()
    }
    @MainActor func testContradictoryFillIsIgnoredButMatchingDurableOrderIsAccepted() async throws {
        let socket = StepSocket([ProtocolFixtures.frames["initial"]!, ProtocolFixtures.frames["feed"]!, ProtocolFixtures.frames["position"]!]), client = BotWebSocketClient(credentials: StepCredentials(), journal: StepJournal(), transport: StepTransport([socket]))
        await client.connect(to: try BackendEndpoint("https://paper.example.test"), expectedMode: .paper)
        try await stepUntil { client.portfolio?.positions.count == 1 }
        let contradictory = try stepFrame("alert", sequence: 20) { payload in
            var data = payload["data"] as! [String: Any], receipt = data["receipt"] as! [String: Any]
            receipt["feeLamports"] = 999; data["receipt"] = receipt; payload["data"] = data
        }
        await socket.push(contradictory)
        // The authoritative snapshot may already be finalized when an earlier
        // confirmed fill event is broadcast. Identical effects still match.
        await socket.push(try stepFrame("alert", sequence: 21) { payload in
            var data = payload["data"] as! [String: Any], receipt = data["receipt"] as! [String: Any]
            data["confirmation"] = "confirmed"; receipt["confirmation"] = "confirmed"; data["receipt"] = receipt; payload["data"] = data
        })
        try await stepUntil { client.tradeAlerts.count == 1 }
        XCTAssertTrue(client.tradeAlerts[0].isFill); XCTAssertNotEqual(client.tradeAlerts[0].data.receipt?.feeLamports, 999)
        await client.disconnect()
    }
    func testAffordableAmountsAreExactBoundedAndExcludeSubMinimumOrders() throws {
        let now: Int64 = 100000, reference = ReferenceValue(solUsd: 100, usdcUsd: 1, solUsdc: 100, slot: 1000, at: now)
        let options = BuySizing.choices(maximum: try RawAmount("75432109"), reference: reference, now: now)
        XCTAssertEqual(options.map(\.text), ["0.018858027", "0.037716054", "0.075432109"])
        XCTAssertEqual(BuySizing.choices(maximum: try RawAmount("15000000"), reference: reference, now: now).map(\.text), ["0.015"])
        XCTAssertTrue(BuySizing.choices(maximum: try RawAmount("9999999"), reference: reference, now: now).isEmpty)
        XCTAssertTrue(BuySizing.choices(maximum: try RawAmount("75432109"), reference: reference, now: now + 16000).isEmpty)
        XCTAssertTrue(BuySizing.choices(maximum: try RawAmount("75432109"), reference: nil, now: now).isEmpty)
        XCTAssertTrue(BuySizing.choices(maximum: try RawAmount("0"), reference: reference, now: now).isEmpty)
    }
    func testGraduatingNeedsActualProgressAndDoesNotInventMissingData() throws {
        let baseline = try ServerMessage.decode(ProtocolFixtures.frames["feed"]!)
        guard case .feed(let feed) = baseline else { return XCTFail("Missing feed") }
        XCTAssertTrue(FeedFilter.graduating.tokens(feed.data.tokens, now: feed.at).isEmpty)
        let observed = try stepFrame("feed") { data in
            var tokens = data["tokens"] as! [[String: Any]]; tokens[0]["bondingPct"] = 90; tokens[0]["migrated"] = false; data["tokens"] = tokens
        }
        guard case .feed(let real) = try ServerMessage.decode(observed) else { return XCTFail("Missing feed") }
        XCTAssertEqual(FeedFilter.graduating.tokens(real.data.tokens, now: real.at).count, 1)
        XCTAssertNotNil(BuySizing.blockReason(token: real.data.tokens[0], portfolio: nil, isFresh: false, now: real.at))
    }
}
