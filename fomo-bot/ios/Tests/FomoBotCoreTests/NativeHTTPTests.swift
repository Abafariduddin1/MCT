import XCTest
@testable import FomoBotCore

final class NativeHTTPTests: XCTestCase {
    func testURLSessionAuthenticatesAndResolvesTheOriginalServerCommand() async throws {
        guard let file = ProcessInfo.processInfo.environment["FOMOBOT_LOCAL_PROBE_FILE"] else { throw XCTSkip("Enable the optional local Node fixture to test native HTTP transport.") }
        struct Settings: Decodable { let url: String; let token: String; let id: String }
        let config = try JSONDecoder().decode(Settings.self, from: Data(contentsOf: URL(fileURLWithPath: file)))
        let endpoint = try BackendEndpoint(config.url, allowInsecureLoopback: true), transport = URLSessionControllerTransport()
        let found = try await transport.lookup(id: config.id, endpoint: endpoint, token: config.token)
        guard case .found(let command) = found else { return XCTFail("Original command not found") }
        XCTAssertEqual(command.id, config.id); XCTAssertEqual(command.stage.rawValue, "finalized")
        do { _ = try await transport.lookup(id: config.id, endpoint: endpoint, token: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLM"); XCTFail("Wrong credential accepted") }
        catch { XCTAssertEqual(error as? TransportError, .unauthorized) }
        guard case .notFound = try await transport.lookup(id: "missing_command_0000001", endpoint: endpoint, token: config.token) else { return XCTFail("Missing command must stay missing") }
    }
    @MainActor func testNativeWebSocketReadsActualServerAndPreservesIdentifiedControl() async throws {
        #if os(Linux)
        throw XCTSkip("Linux FoundationNetworking returns unsupported URL (-1002) for WebSockets. Run this native transport test with an Apple SDK.")
        #else
        guard let file = ProcessInfo.processInfo.environment["FOMOBOT_LOCAL_PROBE_FILE"] else { throw XCTSkip("Enable the optional local Node fixture for native WebSocket integration.") }
        struct Settings: Decodable { let url: String; let token: String; let mint: String }
        let config = try JSONDecoder().decode(Settings.self, from: Data(contentsOf: URL(fileURLWithPath: file)))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FileCommandStore(file: directory.appendingPathComponent("commands.json"))
        let endpoint = try BackendEndpoint(config.url, allowInsecureLoopback: true)
        let client = BotWebSocketClient(credentials: ProbeCredential(value: config.token), journal: store)
        await client.connect(to: endpoint, expectedMode: .paper)
        for _ in 0..<400 { if client.isFresh { break }; try await Task.sleep(for: .milliseconds(10)) }
        guard client.isFresh else { await client.disconnect(); return XCTFail("Native WebSocket did not receive the actual server snapshots") }
        XCTAssertEqual(client.portfolio?.mode, .paper)
        try await client.requestChart(MintAddress(config.mint)); try await client.requestPerformance()
        let id = try await client.send(.pause(true))
        for _ in 0..<400 { if client.commands.first(where: { $0.id == id })?.remote?.stage.isTerminal == true && client.performance != nil { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(client.commands.first(where: { $0.id == id })?.remote?.stage.rawValue, "accepted")
        XCTAssertNotNil(client.performance); XCTAssertNotNil(client.charts[try MintAddress(config.mint)])
        await client.disconnect(); XCTAssertNil(client.portfolio)
        await client.connect(to: endpoint, expectedMode: .paper)
        for _ in 0..<400 { if client.isFresh { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(client.isFresh)
        XCTAssertEqual(client.commands.filter { $0.id == id }.count, 1)
        let rows = try await store.load(); XCTAssertEqual(rows.filter { $0.id == id }.count, 1)
        await client.disconnect()
        #endif
    }
}

private struct ProbeCredential: CredentialStore {
    let value: String
    func token(for endpoint: BackendEndpoint) async throws -> String { value }
    func save(_ token: String, for endpoint: BackendEndpoint) async throws { throw CredentialError.unavailable }
    func remove(for endpoint: BackendEndpoint) async throws { throw CredentialError.unavailable }
}
