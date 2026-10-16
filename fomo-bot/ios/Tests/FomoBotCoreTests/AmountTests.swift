import XCTest
@testable import FomoBotCore

final class AmountTests: XCTestCase {
    func testExactAmounts() throws {
        XCTAssertEqual(try SolAmount("0.000000001").lamports.description, "1")
        XCTAssertEqual(try SolAmount("12.340000001").lamports.description, "12340000001")
        XCTAssertEqual(try RawAmount("18446744073709551615").description, "18446744073709551615")
        XCTAssertEqual(try RawAmount("1").formatted(), "<0.000001")
        XCTAssertEqual(try RawAmount("-1234500000").formatted(), "−1.2345")
        XCTAssertEqual(try RawAmount("1000000000").formatted(includePlus: true), "+1")
    }
    func testRejectsAmbiguousAmounts() {
        for text in ["0", "-1", "1e-3", "NaN", ".1", "01", "1.", "0.0000000001", " 1", "1,2"] { XCTAssertThrowsError(try SolAmount(text), text) }
        for text in ["01", "+1", "-0", "1.5", "1e9", "１２", ""] { XCTAssertThrowsError(try RawAmount(text), text) }
        XCTAssertThrowsError(try JSONDecoder().decode(RawAmount.self, from: Data("9007199254740993".utf8)))
    }
    func testMintValidation() throws {
        XCTAssertNoThrow(try MintAddress("So11111111111111111111111111111111111111112"))
        XCTAssertNoThrow(try MintAddress(String(repeating: "1", count: 32)))
        for mint in [String(repeating: "1", count: 33), "bad", String(repeating: "0", count: 44), String(repeating: "z", count: 44)] { XCTAssertThrowsError(try MintAddress(mint)) }
    }
}
