// swift-tools-version: 5.9
import PackageDescription

// The package name and the library product name are BOTH derived by the
// Capacitor CLI from the npm name `@chatterang/plugin-llama-cpp`. Renaming
// either one here makes `cap sync ios` write a reference SPM cannot resolve:
//   product 'ChatterangPluginLlamaCpp' required by package 'capapp-spm'
//   target 'CapApp-SPM' not found in package 'ChatterangPluginLlamaCpp'
//
// `.iOS(.v15)` is not a preference. Capacitor's generated
// ios/App/CapApp-SPM/Package.swift pins .v15 and is headed "DO NOT MODIFY THIS
// FILE - managed by Capacitor CLI"; declaring .v16 here is rejected outright.
let package = Package(
    name: "ChatterangPluginLlamaCpp",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "ChatterangPluginLlamaCpp",
            targets: ["LlamaCppPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        // llama.cpp is not vendored into the tree. `tools/build-llama-xcframework.sh`
        // clones a pinned tag into .cache/ and builds this artefact; both the
        // clone and the artefact are gitignored.
        //
        // The path must be RELATIVE TO THE PACKAGE ROOT — SwiftPM rejects an
        // absolute one with "invalid local path ... path expected to be
        // relative to package root".
        .binaryTarget(
            name: "llama",
            path: "ios/llama.xcframework"),
        .target(
            name: "LlamaCppPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                "llama"
            ],
            path: "ios/Sources/LlamaCppPlugin")
    ]
)
