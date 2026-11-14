import AppKit
import LocalAuthentication

let bytes = FileHandle.standardInput.readDataToEndOfFile()
guard bytes.count <= 32768, let request = try? JSONDecoder().decode(Request.self, from: bytes),
      request.scope.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      (URLComponents(string: request.origin)?.scheme == "https" || ["web-list","list-items"].contains(request.action)) else { cancel() }
let parent = getppid()
guard parent > 1 else { cancel() }
let parentExit = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
parentExit.setEventHandler { cancel() }
parentExit.resume()
guard getppid() == parent else { cancel() }
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let context = LAContext()
let reason: String
if request.action == "change-item", let change = request.change {
    let verb = change.operation == "delete" ? "Delete" : "Save"
    reason = verb + " “" + String(change.title.prefix(100)) + "” for " + request.origin + " in your Space Vault"
} else if request.action == "list-items" {
    reason = "Unlock your Vault item details for Space at " + request.origin
} else {
    reason = request.action == "web-list"
    ? "Share Vault item titles, websites and types with your Space web session at " + request.origin
    : request.action == "save-linear" ? "Save a Linear API token from Space to your personal Keychain"
    : "Unlock your Space Vault for " + request.origin
}
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
    DispatchQueue.main.async {
        guard ok else { cancel() }
        do { try run(request) } catch { reply(["status": "unavailable"]) }
    }
}
application.run()
