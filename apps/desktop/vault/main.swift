import AppKit
import LocalAuthentication

let bytes = FileHandle.standardInput.readDataToEndOfFile()
guard bytes.count <= 32768, let request = try? JSONDecoder().decode(Request.self, from: bytes),
      request.scope.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      (URLComponents(string: request.origin)?.scheme == "https" || request.action == "web-list") else { cancel() }
let parent = getppid()
guard parent > 1 else { cancel() }
let parentExit = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
parentExit.setEventHandler { cancel() }
parentExit.resume()
guard getppid() == parent else { cancel() }
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let context = LAContext()
let reason = request.action == "web-list"
    ? "Share Vault item titles, websites and types with your Space web session at " + request.origin
    : "Unlock your Space Vault for " + request.origin
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
    DispatchQueue.main.async {
        guard ok else { cancel() }
        do { try run(request) } catch { reply(["status": "unavailable"]) }
    }
}
application.run()
