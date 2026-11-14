import SwiftUI

struct VaultEditor: View {
    @State var draft: VaultDraft
    @State private var error = ""
    let save: (VaultDraft) throws -> Void
    let close: () -> Void

    var fixedToken = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(draft.editing ? "Edit item" : fixedToken ? "New API token" : "New item").font(VaultStyle.font(22, bold: true))
            if !draft.editing && !fixedToken {
                Picker("Category", selection: $draft.token) {
                    Text("Login").tag(false)
                    Text("API token").tag(true)
                }.pickerStyle(.segmented)
            }
            VStack(alignment: .leading, spacing: 13) {
                input("Title", TextField("Work account", text: $draft.label))
                input("Website", TextField("https://example.com", text: $draft.website).disabled(draft.editing || fixedToken))
                if draft.token {
                    input("MCP endpoint", TextField("https://mcp.example.com/mcp", text: $draft.endpoint).disabled(draft.editing || fixedToken))
                } else {
                    input("Username", TextField("Username or email", text: $draft.username))
                }
                input(draft.token ? "API token" : "Password",
                      SecureField(draft.editing ? "Leave blank to keep the current value" : "Required", text: $draft.secret))
            }
            if !error.isEmpty { Text(error).foregroundColor(VaultStyle.danger).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Spacer()
                Button("Cancel", action: close).buttonStyle(VaultButtonStyle()).keyboardShortcut(.cancelAction)
                Button("Save") {
                    do { try save(draft); close() }
                    catch { self.error = (error as? VaultIssue)?.errorDescription ?? "Could not save to Keychain. Try again." }
                }.buttonStyle(VaultButtonStyle(primary: true)).keyboardShortcut(.defaultAction)
            }
        }.font(VaultStyle.font()).foregroundColor(VaultStyle.text).padding(24).frame(width: 432)
            .background(VaultStyle.surfaceRaised).accentColor(VaultStyle.focus)
    }

    private func input<V: View>(_ title: String, _ field: V) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(VaultStyle.font(13, bold: true)).foregroundColor(VaultStyle.text)
            field.accessibilityLabel(title).textFieldStyle(.plain).padding(.horizontal, 10).frame(height: 36)
                .background(VaultStyle.surface).cornerRadius(4)
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(VaultStyle.borderStrong).allowsHitTesting(false))
        }
    }
}
