import SwiftUI
import AppKit
import LocalAuthentication

// One native Vault per Space window session. JavaScript receives only its closing status.
@MainActor final class EmbeddedVault: ObservableObject {
    @Published var entries: [VaultEntry]?
    @Published var unlocking = false
    @Published var message = ""
    let store: VaultStore
    let site, endpoint: String
    let tokenSetup: Bool
    private var context: LAContext?
    private weak var window: NSWindow?
    private weak var previousResponder: NSResponder?
    private var host: NSView?
    private var done: ((Int32) -> Void)?

    init(store: VaultStore, site: String, endpoint: String, tokenSetup: Bool, done: @escaping (Int32) -> Void) {
        self.store = store; self.site = site; self.endpoint = endpoint
        self.tokenSetup = tokenSetup; self.done = done
    }

    func attach(to content: NSView, dark: Bool) {
        _ = VaultStyle.bundledFonts
        let view = NSHostingView(rootView: EmbeddedVaultPage(session: self))
        view.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window = content.window; previousResponder = window?.firstResponder
        view.frame = content.bounds
        view.autoresizingMask = [.width, .height]
        content.addSubview(view, positioned: .above, relativeTo: nil)
        host = view
        window?.makeFirstResponder(view)
    }

    func unlock() {
        guard done != nil, !unlocking else { return }
        unlocking = true; message = ""
        let auth = LAContext()
        context = auth
        auth.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock your personal Space Vault") { [weak self] allowed, _ in
            DispatchQueue.main.async {
                guard let self, self.done != nil, self.context === auth else { return }
                self.unlocking = false; self.context = nil
                guard allowed else { self.message = "Vault is locked. Try again when you’re ready."; return }
                do { self.entries = try self.store.entries() }
                catch { self.message = "Could not read Keychain. Try again." }
            }
        }
    }

    func lock() {
        context?.invalidate(); context = nil
        entries = nil; unlocking = false; message = ""
    }

    func finish(_ status: Int32) {
        guard let callback = done else { return }
        done = nil
        if let sheet = window?.attachedSheet, entries != nil { window?.endSheet(sheet, returnCode: .cancel) }
        lock()
        host?.removeFromSuperview(); host = nil
        if let previousResponder { window?.makeFirstResponder(previousResponder) }
        callback(status)
    }
}

private struct EmbeddedVaultPage: View {
    @ObservedObject var session: EmbeddedVault
    var body: some View {
        Group {
            if let entries = session.entries {
                VaultManager(store: session.store, origin: session.site, endpoint: session.endpoint,
                             lock: session.lock, tokenSetup: session.tokenSetup, finished: { session.finish($0 ? 1 : 0) },
                             entries: entries, selected: entries.first { $0.origin == session.site }?.id)
            } else {
                VStack(spacing: 0) {
                    VaultPageHeader(back: { session.finish(0) })
                    VStack(alignment: .leading, spacing: 16) {
                        Image(systemName: "lock").font(.system(size: 22, weight: .medium))
                            .frame(width: 44, height: 44).foregroundColor(VaultStyle.accent)
                            .background(VaultStyle.accentSoft).cornerRadius(8).accessibilityHidden(true)
                        Text("Unlock your Vault").font(VaultStyle.font(22, bold: true))
                        Text("Use Touch ID or your Mac password to access your saved logins and API tokens.")
                            .foregroundColor(VaultStyle.textSecondary).fixedSize(horizontal: false, vertical: true)
                        if !session.message.isEmpty { Text(session.message).foregroundColor(VaultStyle.textSecondary) }
                        Button(session.unlocking ? "Unlocking…" : "Unlock Vault", action: session.unlock)
                            .buttonStyle(VaultButtonStyle(primary: true)).keyboardShortcut(.defaultAction)
                            .disabled(session.unlocking)
                    }.padding(24).frame(width: 376, alignment: .leading)
                        .background(VaultStyle.surfaceRaised).cornerRadius(12)
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(VaultStyle.border).allowsHitTesting(false))
                        .frame(maxWidth: .infinity, maxHeight: .infinity).background(VaultStyle.surfaceSubtle)
                }
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).font(VaultStyle.font()).foregroundColor(VaultStyle.text).background(VaultStyle.surface)
    }
}

// Electron supplies its own NSView pointer via BaseWindow.getNativeWindowHandle().
@_cdecl("space_vault_attach")
@MainActor func attachVault(_ parent: UnsafeMutableRawPointer, _ scope: UnsafePointer<CChar>, _ site: UnsafePointer<CChar>,
                            _ endpoint: UnsafePointer<CChar>, _ setup: Bool, _ dark: Bool, _ cookie: UnsafeMutableRawPointer,
                            _ complete: @escaping @convention(c) (UnsafeMutableRawPointer, Int32) -> Void) -> UnsafeMutableRawPointer {
    let session = EmbeddedVault(store: VaultStore(scope: String(cString: scope)), site: String(cString: site),
                                endpoint: String(cString: endpoint), tokenSetup: setup, done: { complete(cookie, $0) })
    session.attach(to: Unmanaged<NSView>.fromOpaque(parent).takeUnretainedValue(), dark: dark)
    return Unmanaged.passRetained(session).toOpaque()
}

@_cdecl("space_vault_detach")
@MainActor func detachVault(_ session: UnsafeMutableRawPointer) {
    Unmanaged<EmbeddedVault>.fromOpaque(session).takeRetainedValue().finish(0)
}
