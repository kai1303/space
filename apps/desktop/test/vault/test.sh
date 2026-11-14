#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
node scripts/build-vault-theme.cjs "$build/VaultColors.swift"
xcrun swiftc "$build/VaultColors.swift" vault/VaultStyle.swift vault/Keychain.swift vault/VaultStore.swift vault/VaultEditor.swift vault/VaultManager.swift test/vault/main.swift -o "$build/test-vault"
"$build/test-vault"
