#!/bin/sh
# Run on macOS with an installed Xcode iOS Simulator SDK. This compiles the
# actual iOS branches, unlike a Linux or ordinary macOS Swift-package build.
set -eu
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin || { echo 'Requires macOS and the Xcode iOS Simulator SDK.' >&2; exit 1; }
sdk_path=$(xcrun --sdk iphonesimulator --show-sdk-path)
swift_compiler=$(xcrun --find swiftc)
target_arch=${SIMULATOR_ARCH:-$(uname -m)}
module_dir=$(mktemp -d)
trap 'rm -rf "$module_dir"' EXIT HUP INT TERM
"$swift_compiler" --version
"$swift_compiler" -swift-version 6 -sdk "$sdk_path" -target "$target_arch-apple-ios18.0-simulator" \
    -parse-as-library -emit-module -module-name FomoBotCore -emit-module-path "$module_dir/FomoBotCore.swiftmodule" Sources/FomoBotCore/*.swift
"$swift_compiler" -swift-version 6 -sdk "$sdk_path" -target "$target_arch-apple-ios18.0-simulator" \
    -parse-as-library -emit-module -module-name FomoBotUI -emit-module-path "$module_dir/FomoBotUI.swiftmodule" -I "$module_dir" Sources/FomoBotUI/*.swift
"$swift_compiler" -swift-version 6 -sdk "$sdk_path" -target "$target_arch-apple-ios18.0-simulator" \
    -parse-as-library -typecheck -I "$module_dir" App/FomoBotApp.swift
echo 'iOS core, screens and application entry passed Apple SDK type checking.'
