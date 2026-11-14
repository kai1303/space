// Built separately from the production helper, with a unique Keychain service for every run.
import AppKit
import SwiftUI
import Security

@MainActor func verify() throws {
    let scope = UUID().uuidString
    let store = VaultStore(scope: scope)
    defer { SecItemDelete(vaultQuery(scope) as CFDictionary) }
    _ = NSApplication.shared
    let workspace = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 660),
                             styleMask: [.titled], backing: .buffered, defer: false)
    let content = NSView()
    workspace.contentView = content
    var completion: [Int32] = []
    let session = EmbeddedVault(store: store, site: "", endpoint: "", tokenSetup: false) { completion.append($0) }
    precondition(session.attach(to: content, dark: true))
    guard let sheet = workspace.attachedSheet else { fatalError("Vault sheet missing") }
    precondition(sheet.frame.width < workspace.frame.width && workspace.contentView === content)
    let second = EmbeddedVault(store: store, site: "", endpoint: "", tokenSetup: false) { _ in fatalError("Unexpected close") }
    precondition(!second.attach(to: content, dark: true))
    session.finish(0)
    session.finish(0)
    precondition(completion == [0])
    workspace.orderOut(nil)
    func change(_ fields:[String:String]) throws -> [String:Any] {
        let encoded = try JSONSerialization.data(withJSONObject:fields)
        return try JSONDecoder().decode(WebItemChange.self, from:encoded).apply(to:store)
    }
    for kind in ["login","token"] {
        var fields = ["operation":"create","title":"Work","site":"https://example.com","kind":kind,
                      "username":"test","secret":"fixture-only","endpoint":""]
        let created = try change(fields)["item"] as! [String:String]
        precondition(created["id"] != nil && created["version"] != nil && created["secret"] == nil)
        fields.merge(["operation":"edit","title":"Renamed","secret":"","id":created["id"]!,"version":created["version"]!]) { _, new in new }
        let edited = try change(fields)["item"] as! [String:String]
        let saved = try store.entries().first!
        let retained = try store.reveal(saved)
        precondition(edited["version"] != created["version"] && retained == "fixture-only")
        fields["operation"] = "delete"
        do { _ = try change(fields); fatalError("Stale deletion accepted") } catch is VaultIssue {}
        fields["version"] = edited["version"]
        let deleted = try change(fields)
        let remaining = try store.entries()
        precondition(deleted["status"] as? String == "deleted" && remaining.isEmpty)
    }
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
