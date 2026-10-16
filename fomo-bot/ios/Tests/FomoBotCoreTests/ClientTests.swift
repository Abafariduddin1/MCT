import XCTest
@testable import FomoBotCore

private enum TestError: Error { case offline, disk }
private actor TestCredentials: CredentialStore {
    var value = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLM"
    func token(for endpoint: BackendEndpoint) -> String { value }
    func save(_ token: String, for endpoint: BackendEndpoint) { value = token }
    func remove(for endpoint: BackendEndpoint) { value = "" }
}
private actor TestCommands: CommandStore {
    var rows: [LocalCommand] = []; var fail = false
    func load() -> [LocalCommand] { rows }
    func setFail() { fail = true }
    func upsert(_ row: LocalCommand) throws { if fail { throw TestError.disk }; if let i = rows.firstIndex(where: { $0.id == row.id }) { rows[i] = row } else { rows.append(row) } }
}
private actor TestSocket: SocketConnection {
    var frames: [Data] = []; var sent: [Data] = []; var waiting: CheckedContinuation<Data, any Error>?; var closed = false; var failTrade = false; var nextError: (any Error)?
    func push(_ data: Data) { if let c = waiting { waiting = nil; c.resume(returning: data) } else { frames.append(data) } }
    func failNextTrade() { failTrade = true }
    func failReceive(_ error: any Error) { if let c = waiting { waiting = nil; c.resume(throwing: error) } else { nextError = error } }
    func receive() async throws -> Data { if let error = nextError { nextError = nil; throw error }; if closed { throw TestError.offline }; if !frames.isEmpty { return frames.removeFirst() }; return try await withCheckedThrowingContinuation { waiting = $0 } }
    func send(_ data: Data) throws {
        sent.append(data)
        if failTrade, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], object["type"] as? String == "QUICK_TRADE" { failTrade = false; throw TestError.offline }
    }
    func ping() {}
    func close() { closed = true; waiting?.resume(throwing: TestError.offline); waiting = nil }
    func tradeCount() -> Int { sent.filter { (try? JSONSerialization.jsonObject(with: $0) as? [String: Any])?["type"] as? String == "QUICK_TRADE" }.count }
}
private actor TestTransport: ControllerTransport {
    var sockets: [TestSocket]; var opens = 0; var lookups: [String] = []; var found: [String: CommandRecord] = [:]
    init(_ sockets: [TestSocket]) { self.sockets = sockets }
    func open(endpoint: BackendEndpoint, token: String) throws -> any SocketConnection { guard opens < sockets.count else { throw TestError.offline }; let s = sockets[opens]; opens += 1; return s }
    func lookup(id: String, endpoint: BackendEndpoint, token: String) -> CommandLookup { lookups.append(id); return found[id].map(CommandLookup.found) ?? .notFound }
    func setFound(_ remote: CommandRecord) { found[remote.id] = remote }
}
@MainActor private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<200 { if condition() { return }; try await Task.sleep(for: .milliseconds(10)) }
    XCTFail("Client state did not converge"); throw TestError.offline
}
@MainActor private func synchronize(_ client: BotWebSocketClient, _ socket: TestSocket) async throws {
    await socket.push(ProtocolFixtures.frames["initial"]!); await socket.push(ProtocolFixtures.frames["feed"]!)
    try await waitUntil { client.connectionState == .ready }
}
final class ClientTests: XCTestCase {
    @MainActor func testNeedsBothSnapshotsAndPersistsBeforeSendingOneTrade() async throws {
        let socket = TestSocket(), store = TestCommands(), transport = TestTransport([socket]); let client = BotWebSocketClient(credentials: TestCredentials(), journal: store, transport: transport)
        addTeardownBlock { await client.disconnect() }
        await client.connect(to: try BackendEndpoint("https://example.test")); await socket.push(ProtocolFixtures.frames["initial"]!)
        try await Task.sleep(for: .milliseconds(20)); XCTAssertNotEqual(client.connectionState, .ready)
        await socket.push(ProtocolFixtures.frames["feed"]!); try await waitUntil { client.isFresh }
        let payload = CommandPayload.buy(mint: try MintAddress("So11111111111111111111111111111111111111112"), amount: try SolAmount("0.05"))
        let id = try await client.send(payload); let duplicate = try await client.send(payload)
        XCTAssertEqual(id, duplicate); let saved = await store.load(), count = await socket.tradeCount(); XCTAssertEqual(saved.count, 1); XCTAssertEqual(count, 1); XCTAssertTrue(client.hasPendingFinancialAction)
    }
    @MainActor func testJournalFailurePreventsSocketSend() async throws {
        let socket = TestSocket(), store = TestCommands(), client = BotWebSocketClient(credentials: TestCredentials(), journal: store, transport: TestTransport([socket]))
        addTeardownBlock { await client.disconnect() }; await client.connect(to: try BackendEndpoint("https://example.test")); try await synchronize(client, socket); await store.setFail()
        do { _ = try await client.send(.panic); XCTFail("Expected failed persistence") } catch {}
        let count = await socket.tradeCount(); XCTAssertEqual(count, 0); XCTAssertTrue(client.commands.isEmpty)
    }
    @MainActor func testUnknownDeliveryIsReadByOriginalIDAfterReconnectWithoutResending() async throws {
        let first = TestSocket(), second = TestSocket(), store = TestCommands(), transport = TestTransport([first, second]); let client = BotWebSocketClient(credentials: TestCredentials(), journal: store, transport: transport)
        addTeardownBlock { await client.disconnect() }; let endpoint = try BackendEndpoint("https://example.test")
        await client.connect(to: endpoint); try await synchronize(client, first); await first.failNextTrade()
        let id = try await client.send(.buy(mint: MintAddress("So11111111111111111111111111111111111111112"), amount: SolAmount("0.05")))
        XCTAssertEqual(client.commands.first?.delivery, .unknown)
        await transport.setFound(ProtocolFixtures.command(id: id)); await client.connect(to: endpoint); try await synchronize(client, second)
        try await waitUntil { client.commands.first?.remote?.stage.isTerminal == true }
        let count = await second.tradeCount(), ids = await transport.lookups; XCTAssertEqual(count, 0); XCTAssertTrue(ids.contains(id)); XCTAssertEqual(client.commands.first?.id, id)
    }
    @MainActor func testMissingOriginalRecordStaysUnknownAndCannotBeReplayed() async throws {
        let first = TestSocket(), second = TestSocket(), store = TestCommands(), transport = TestTransport([first, second]); let client = BotWebSocketClient(credentials: TestCredentials(), journal: store, transport: transport)
        addTeardownBlock { await client.disconnect() }; let endpoint = try BackendEndpoint("https://example.test")
        await client.connect(to: endpoint); try await synchronize(client, first)
        let payload = CommandPayload.buy(mint: try MintAddress("So11111111111111111111111111111111111111112"), amount: try SolAmount("0.05")); let id = try await client.send(payload)
        await client.connect(to: endpoint); try await synchronize(client, second); try await waitUntil { client.commands.first?.delivery == .unknown }
        let repeated = try await client.send(payload); XCTAssertEqual(repeated, id); let count = await second.tradeCount(); XCTAssertEqual(count, 0); XCTAssertTrue(client.commands.first?.isUnresolved == true)
    }
    @MainActor func testAuthenticationFailureDoesNotLoopOrRevealCredential() async throws {
        let socket = TestSocket(), transport = TestTransport([socket]), client = BotWebSocketClient(credentials: TestCredentials(), journal: TestCommands(), transport: transport)
        addTeardownBlock { await client.disconnect() }; await client.connect(to: try BackendEndpoint("https://example.test")); await socket.failReceive(TransportError.unauthorized)
        try await waitUntil { if case .blocked = client.connectionState { return true }; return false }
        let opens = await transport.opens; XCTAssertEqual(opens, 1); XCTAssertEqual(client.lastError, "Authentication failed.")
    }
    @MainActor func testBackgroundingStopsMutationAndResumesWithFreshSnapshots() async throws {
        let first = TestSocket(), second = TestSocket(), transport = TestTransport([first, second]), client = BotWebSocketClient(credentials: TestCredentials(), journal: TestCommands(), transport: transport)
        addTeardownBlock { await client.disconnect() }; await client.connect(to: try BackendEndpoint("https://example.test")); try await synchronize(client, first)
        await client.setForeground(false); XCTAssertEqual(client.connectionState, .suspended); XCTAssertFalse(client.isFresh)
        do { _ = try await client.send(.panic); XCTFail("Background send should fail") } catch {}
        await client.setForeground(true); XCTAssertNotEqual(client.connectionState, .ready); try await synchronize(client, second); XCTAssertTrue(client.isFresh)
    }
    @MainActor func testUnknownProtocolBlocksTradingAndDuplicateAlertsAreNotRepeated() async throws {
        let socket = TestSocket(), client = BotWebSocketClient(credentials: TestCredentials(), journal: TestCommands(), transport: TestTransport([socket]))
        addTeardownBlock { await client.disconnect() }; await client.connect(to: try BackendEndpoint("https://example.test")); try await synchronize(client, socket)
        await socket.push(ProtocolFixtures.frames["position"]!)
        let alert = ProtocolFixtures.frames["alert"]!; await socket.push(alert); await socket.push(alert)
        try await waitUntil { client.tradeAlerts.count == 1 }; XCTAssertEqual(client.tradeAlerts[0].display, "Paper fill")
        var invalid = try JSONSerialization.jsonObject(with: alert) as! [String: Any]; invalid["v"] = 2; invalid["seq"] = 9999
        await socket.push(try JSONSerialization.data(withJSONObject: invalid)); try await waitUntil { if case .blocked = client.connectionState { return true }; return false }; XCTAssertFalse(client.isFresh)
    }
}
final class JournalTests: XCTestCase {
    func testDiskJournalPreservesIDAndRefusesChangedPayload() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString), file = dir.appendingPathComponent("commands.json")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileCommandStore(file: file), endpoint = try BackendEndpoint("https://example.test")
        let command = try CommandEnvelope(payload: .pause(true)); let item = LocalCommand(envelope: command, endpoint: endpoint, wallet: "paper", mode: .paper)
        try await store.upsert(item); let second = FileCommandStore(file: file); let loaded = try await second.load(); XCTAssertEqual(loaded.first?.id, command.id)
        let changed = LocalCommand(envelope: try CommandEnvelope(id: command.id, payload: .pause(false)), endpoint: endpoint, wallet: "paper", mode: .paper)
        do { try await second.upsert(changed); XCTFail("Changed duplicate was accepted") } catch {}
        try Data(#"{"version":99,"commands":[]}"#.utf8).write(to: file)
        do { _ = try await second.load(); XCTFail("Unknown journal silently reset") } catch {}
    }
}
final class PreferenceTests: XCTestCase {
    @MainActor func testEndpointPreferencesContainNoCredentialAndRoundTrip() async throws {
        let suite = "fomobot-test-" + UUID().uuidString, defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ConnectionPreferences(defaults: defaults), endpoint = try BackendEndpoint("https://example.test:8787")
        try preferences.save(endpoint); XCTAssertEqual(try preferences.load(), endpoint)
        XCTAssertFalse(String(describing: defaults.dictionaryRepresentation()).contains("Bearer")); preferences.remove(); XCTAssertNil(try preferences.load())
    }
}
final class JournalOrderingTests: XCTestCase {
    func testLateSendCompletionAndStaleLookupCannotDowngradeARecordedFill() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileCommandStore(file: dir.appendingPathComponent("commands.json")), endpoint = try BackendEndpoint("https://example.test")
        let envelope = try CommandEnvelope(payload: .buy(mint: MintAddress("So11111111111111111111111111111111111111112"), amount: SolAmount("0.05")))
        var queued = LocalCommand(envelope: envelope, endpoint: endpoint, wallet: "paper", mode: .paper); try await store.upsert(queued)
        var filled = queued; filled.remote = ProtocolFixtures.command(id: queued.id); filled.delivery = .acknowledged; try await store.upsert(filled)
        queued.delivery = .sent; try await store.upsert(queued)
        var stale = queued; stale.remote = ProtocolFixtures.command(id: queued.id, stage: "received"); try await store.upsert(stale)
        let saved = try await store.load(); XCTAssertEqual(saved[0].remote?.stage.rawValue, "finalized"); XCTAssertEqual(saved[0].delivery, .acknowledged)
    }
}
