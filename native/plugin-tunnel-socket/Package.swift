// swift-tools-version: 5.9
import PackageDescription

// The package name and the library product name are BOTH derived by the
// Capacitor CLI from the npm name `@chatterang/plugin-tunnel-socket`. Renaming
// either one here makes `cap sync ios` write a reference SPM cannot resolve —
// see `native/plugin-llama-cpp/Package.swift`'s own note, which this mirrors.
//
// `.iOS(.v15)` is not a preference: Capacitor's generated
// `ios/App/CapApp-SPM/Package.swift` pins .v15 and rejects a higher one
// declared here. `URLSessionWebSocketTask` and its delegate methods are
// available from iOS 13, so this plugin needs nothing newer than the app's own
// floor.
let package = Package(
    name: "ChatterangPluginTunnelSocket",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "ChatterangPluginTunnelSocket",
            targets: ["TunnelSocketPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "TunnelSocketPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
            ],
            path: "ios/Sources/TunnelSocketPlugin")
    ]
)
