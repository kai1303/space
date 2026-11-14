// Runs only on the paired Mac. Secrets travel over an anonymous pipe to Space Desktop.
import AppKit
import LocalAuthentication
import Security

struct Request: Decodable {
    let action: String
    let scope: String
    let origin: String
    let agent: String?
    let endpoint: String?
    let item: UUID?
    let title: String?
    let token: String?
    let change: WebItemChange?
    let tool: String?
    let arguments: String?
}
struct WebItemChange: Decodable {
    let operation, title, site: String
    let id, version: UUID?
    let kind, username, endpoint, secret: String?

    func apply(to store: VaultStore) throws -> [String:Any] {
        let origin = try VaultDraft.site(site)
        var entry: VaultEntry?
        if operation != "create" {
            guard let id, let version,
                  let item = try readItems(vaultQuery(store.scope, origin: origin)).first(where: { $0.id == id }),
                  (item.version ?? item.id) == version else { throw VaultIssue.stale }
            entry = VaultEntry(item, origin: origin)
        }
        if operation == "delete", let entry {
            guard title == entry.label else { throw VaultIssue.stale }
            try store.remove(entry, expectedVersion: version)
            return ["status":"deleted"]
        }
        guard operation == "edit" || operation == "create", kind == "token" || kind == "login",
              entry == nil || entry?.kind == kind, let secret else { throw Failure.unavailable }
        var draft = VaultDraft(entry: entry, origin: origin, token: kind == "token")
        draft.label = title; draft.secret = secret; draft.username = username ?? ""
        draft.endpoint = endpoint ?? ""
        if let entry, entry.isToken, draft.endpoint != (entry.endpoint ?? ""), secret.isEmpty {
            throw VaultIssue("Enter a new token when changing its endpoint.")
        }
        let saved = try store.save(draft, expectedVersion: version)
        guard let item = try readItems(vaultQuery(store.scope, origin:origin)).first(where: { $0.id == saved }) else { throw Failure.unavailable }
        return ["status":"saved", "item": VaultEntry(item, origin:origin).metadata]
    }
}
func reply(_ result: [String: String]) -> Never {
    if let data = try? JSONEncoder().encode(result) { FileHandle.standardOutput.write(data) }
    exit(0)
}
func cancel() -> Never { reply(["status": "cancelled"]) }

func prompt(_ title: String, _ detail: String, _ buttons: [String], _ view: NSView? = nil) -> Int {
    let box = NSAlert()
    box.messageText = title
    box.informativeText = detail
    for label in buttons { box.addButton(withTitle: label) }
    box.accessoryView = view
    box.buttons.last?.keyEquivalent = "\u{1b}"
    if let first = view?.subviews.compactMap({ $0 as? NSTextField }).first(where: { $0.isEditable }) {
        box.window.initialFirstResponder = first
    }
    NSApp.activate(ignoringOtherApps: true)
    return box.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
}

func picker(_ items: [Item]) -> NSPopUpButton {
    let menu = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 340, height: 28))
    for item in items { menu.addItem(withTitle: item.label + (item.kind == "login" ? " · Login" : " · API token")) }
    return menu
}
@MainActor func run(_ req: Request) throws {
    if req.action == "change-item", let change = req.change {
        do {
            let result = try change.apply(to: VaultStore(scope:req.scope))
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
            exit(0)
        } catch let issue as VaultIssue {
            if issue.errorDescription == VaultIssue.stale.errorDescription { reply(["status":"stale"]) }
            if issue.errorDescription == VaultIssue.duplicate.errorDescription { reply(["status":"duplicate"]) }
            reply(["status":"invalid"])
        }
    }
    if req.action == "save-linear" {
        guard let title = req.title, let token = req.token, req.origin == "https://linear.app" else { throw Failure.unavailable }
        let store = VaultStore(scope: req.scope)
        var draft = VaultDraft(origin: req.origin, endpoint: "https://mcp.linear.app/mcp", token: true)
        draft.label = title; draft.secret = token
        do { _ = try store.save(draft) }
        catch let issue as VaultIssue where issue.errorDescription == VaultIssue.duplicate.errorDescription {
            reply(["status":"duplicate"])
        }
        let result: [String:Any] = ["status":"saved", "item":["title":title, "site":draft.website, "kind":"token"]]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
        exit(0)
    }
    if req.action == "web-list" || req.action == "list-items" {
        let entries = try VaultStore(scope: req.scope).entries()
        let items = req.action == "list-items" ? entries.map(\.metadata) : entries.map { ["title": $0.label, "site": $0.origin, "kind": $0.kind] }
        let data = try JSONSerialization.data(withJSONObject: ["status": "listed", "more": false, "items": items])
        FileHandle.standardOutput.write(data)
        exit(0)
    }
    let query = vaultQuery(req.scope, origin: req.origin)
    let items = try readItems(query)
    if req.action == "list-api" || req.action == "call-api" {
        guard let agent = req.agent, let endpoint = req.endpoint else { throw Failure.unavailable }
        let tokens = items.filter { $0.kind == "token" && $0.endpoint == endpoint && (req.action == "list-api" || $0.id == req.item) }
        guard !tokens.isEmpty else { reply(["status": "no_matching_token"]) }
        let menu = picker(tokens)
        let listing = req.action == "list-api"
        let title = listing ? "Allow " + agent + " to list tools?" : "Allow " + agent + " to run " + (req.tool ?? "") + "?"
        let detail = listing ? endpoint : endpoint + "\n\nArguments\n" + (req.arguments ?? "{}")
        guard prompt(title, detail, ["Allow once", "Cancel"], menu) == 0, tokens.indices.contains(menu.indexOfSelectedItem) else { cancel() }
        let item = tokens[menu.indexOfSelectedItem]
        reply(["status": "approved", "token": item.secret, "item": item.id.uuidString])
    }
    guard req.action == "fill", let agent = req.agent else { throw Failure.unavailable }
    let logins = items.filter { $0.kind == "login" }
    guard !logins.isEmpty else { reply(["status": "no_matching_login"]) }
    let menu = picker(logins)
    guard prompt(agent == "you" ? "Fill a saved login?" : "Allow " + agent + " to fill a login?", req.origin + "\nChoose an account. You will submit the form yourself.", ["Allow once", "Cancel"], menu) == 0,
          logins.indices.contains(menu.indexOfSelectedItem) else { cancel() }
    let item = logins[menu.indexOfSelectedItem]
    reply(["status": "approved", "username": item.username, "password": item.secret])
}
