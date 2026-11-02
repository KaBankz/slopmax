// swift-tools-version: 6.0
// SlopmaxKit: everything the macOS app does that is not drawing, on
// Foundation alone, so it builds and its tests run on Linux too (CI checks
// it there against the same contract fixtures as Rust and TypeScript). The
// app itself (Slopmax/, SwiftUI) is built by Xcode from project.yml.
import PackageDescription

let package = Package(
    name: "Slopmax",
    platforms: [.macOS(.v14)],
    products: [.library(name: "SlopmaxKit", targets: ["SlopmaxKit"])],
    targets: [
        .target(name: "SlopmaxKit"),
        .testTarget(name: "SlopmaxKitTests", dependencies: ["SlopmaxKit"]),
    ]
)
