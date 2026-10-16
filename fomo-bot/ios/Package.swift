// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FomoBotKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "FomoBotCore", targets: ["FomoBotCore"]),
        .library(name: "FomoBotUI", targets: ["FomoBotUI"])
    ],
    targets: [
        .target(name: "FomoBotCore"),
        .target(name: "FomoBotUI", dependencies: ["FomoBotCore"]),
        .testTarget(name: "FomoBotCoreTests", dependencies: ["FomoBotCore"], resources: [.copy("Fixtures")])
    ],
    swiftLanguageModes: [.v6]
)
