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
    let tool: String?
    let arguments: String?
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
    if req.action == "web-list" {
        let entries = try VaultStore(scope: req.scope).entries()
        let items = entries.map { ["title": $0.label, "site": $0.origin, "kind": $0.kind] }
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
