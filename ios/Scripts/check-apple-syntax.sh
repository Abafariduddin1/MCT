#!/bin/sh
# Syntax validation only; an Apple SDK build is still required for SwiftUI,
# UIKit and Security type checking and device behavior.
set -eu
cd "$(dirname "$0")/.."
checks_dir=$(mktemp -d)
trap 'rm -rf "$checks_dir"' EXIT HUP INT TERM
for source in Sources/FomoBotUI/*.swift App/*.swift; do
    case "$source" in
        *Haptics.swift) swiftc -frontend -parse "$source" ;;
        *) sed '1d;$d' "$source" > "$checks_dir/$(basename "$source")"
           swiftc -frontend -parse "$checks_dir/$(basename "$source")" ;;
    esac
done
