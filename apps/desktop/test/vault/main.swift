// Built separately from the production helper, with a unique Keychain service for every run.
import AppKit
import SwiftUI
import Security

@MainActor func verify() throws {
    let scope = UUID().uuidString
    let store = VaultStore(scope: scope)
    defer { SecItemDelete(vaultQuery(scope) as CFDictionary) }
    var login = VaultDraft(origin: "https://GITHUB.com:443/")
    login.label = "GitHub"; login.username = "kai@example.com"; login.secret = UUID().uuidString
    _ = try store.save(login)
    var token = VaultDraft(origin: "https://linear.app", endpoint: "https://mcp.linear.app/mcp", token: true)
    token.label = "Linear MCP"; token.secret = UUID().uuidString
    _ = try store.save(token)
    let entries = try store.entries()
    precondition(entries.count == 2)
    let git = entries[0], linear = entries[1]
    precondition(git.origin == "https://github.com" && linear.isToken && linear.endpoint == token.endpoint)
    let foreign = try VaultStore(scope: UUID().uuidString).entries()
    precondition(foreign.isEmpty)
    var edit = VaultDraft(entry: git)
    precondition(edit.secret.isEmpty)
    edit.username = "new@example.com"
    _ = try store.save(edit)
    let kept = try store.reveal(git)
    precondition(kept == login.secret)
    edit.secret = UUID().uuidString
    _ = try store.save(edit)
    let rotated = try store.reveal(git)
    precondition(rotated == edit.secret)
    do {
        var duplicate = VaultDraft(origin: git.origin)
        duplicate.label = git.label; duplicate.username = "another"; duplicate.secret = "example"
        _ = try store.save(duplicate)
        fatalError("Duplicate accepted")
    } catch is VaultIssue {}
    for value in ["http://example.com", "https://example.com/path", "https://a@b.com", "https://example.com?x"] {
        do { _ = try VaultDraft.site(value); fatalError("Invalid site accepted") } catch is VaultIssue {}
    }
    if let output = ProcessInfo.processInfo.environment["SPACE_VAULT_PREVIEW_PNG"] {
        var example = VaultDraft(origin: "https://linear.app")
        example.label = "Linear"; example.username = "kai@example.com"; example.secret = UUID().uuidString
        _ = try store.save(example)
        example = VaultDraft(origin: "https://notion.so")
        example.label = "Notion"; example.username = "kai@example.com"; example.secret = UUID().uuidString
        _ = try store.save(example)
        VaultStyle.registerFonts(in: URL(fileURLWithPath: "node_modules/@fontsource/lato/files", isDirectory: true))
        let app = NSApplication.shared
        app.appearance = NSAppearance(named: .darkAqua)
        let view = VaultManager(store: store, origin: "", endpoint: "", lock: {},
                                entries: try store.entries(), selected: linear.id)
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 940, height: 535),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Space Vault"; window.contentView = host
        window.orderBack(nil)
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.35))
        host.layoutSubtreeIfNeeded()
        let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds)!
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
    }
    try store.remove(git); try store.remove(linear)
    let remaining = try store.entries()
    precondition(!remaining.contains { $0.id == git.id || $0.id == linear.id })
    do { _ = try store.save(edit); fatalError("Deleted item recreated") } catch is VaultIssue {}
}
do { try MainActor.assumeIsolated { try verify() }; print("Vault Keychain checks passed") } catch { exit(1) }
