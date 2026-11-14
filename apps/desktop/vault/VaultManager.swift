import SwiftUI
import AppKit

private enum Category: String, CaseIterable {
    case all = "All items", login = "Logins", token = "API tokens"
    var icon: String {
        switch self { case .all: return "square.grid.2x2"; case .login: return "key"; case .token: return "terminal" }
    }
    func includes(_ item: VaultEntry) -> Bool { self == .all || (self == .token) == item.isToken }
}

struct VaultManager: View {
    let store: VaultStore
    let origin: String
    let endpoint: String
    let lock: () -> Void
    var tokenSetup = false
    var finished: (Bool) -> Void = { _ in }
    @State var entries: [VaultEntry]
    @State var selected: UUID?
    @FocusState private var searchFocused: Bool
    @State private var search = ""
    @State private var category: Category = .all
    @State private var draft: VaultDraft?
    @State private var deleting: VaultEntry?
    @State private var error = ""
    private var matches: [VaultEntry] {
        entries.filter { item in
            category.includes(item) && (search.isEmpty || [item.label, item.origin, item.username, item.endpoint ?? ""]
                .contains { $0.localizedCaseInsensitiveContains(search) })
        }
    }
    private var detail: VaultEntry? { matches.first { $0.id == selected } ?? matches.first }

    var body: some View {
        VStack(spacing: 0) {
            VaultPageHeader(back: { finished(false) })
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Personal Vault").font(VaultStyle.font(18, bold: true))
                        .foregroundColor(VaultStyle.text).padding(.horizontal, 8).padding(.bottom, 12)
                    ForEach(Category.allCases, id: \.self) { section in
                        Button { category = section } label: {
                            HStack(spacing: 9) {
                                Image(systemName: section.icon).frame(width: 16)
                                Text(section.rawValue)
                                Spacer()
                                Text(String(entries.filter(section.includes).count)).font(VaultStyle.font(12))
                            }.padding(8).contentShape(Rectangle())
                        }.buttonStyle(.plain).foregroundColor(section == category ? VaultStyle.sidebarContentActive : VaultStyle.sidebarText)
                            .background(section == category ? VaultStyle.sidebarSelection : .clear)
                            .cornerRadius(6)
                    }
                    Spacer()
                    Divider().padding(.bottom, 6)
                    Button(action: lock) { Label("Lock Vault", systemImage: "lock") }
                        .buttonStyle(.plain).keyboardShortcut("l", modifiers: [.command, .shift])
                }.padding(.vertical, 20).padding(.horizontal, 12).frame(width: 200).frame(maxHeight: .infinity)
                    .foregroundColor(VaultStyle.sidebarText).background(VaultStyle.sidebar)
                Divider()
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text(category.rawValue).font(VaultStyle.font(18, bold: true))
                        Spacer()
                        Button {
                            draft = VaultDraft(origin: origin, endpoint: endpoint, token: category == .token)
                        } label: { Label("New item", systemImage: "plus") }.buttonStyle(VaultButtonStyle(primary: true, compact: true)).keyboardShortcut("n")
                    }.padding([.top, .horizontal], 16)
                    HStack {
                        Image(systemName: "magnifyingglass").foregroundColor(VaultStyle.textSecondary)
                        TextField("Search items", text: $search).textFieldStyle(.plain).focused($searchFocused)
                            .background(Button("Find") { searchFocused = true }.keyboardShortcut("f").hidden())
                        if !search.isEmpty {
                            Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.plain).accessibilityLabel("Clear search")
                        }
                    }.padding(.horizontal, 8).frame(height: 32).background(VaultStyle.surface)
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(VaultStyle.borderStrong)).padding(16)
                    Divider()
                    if matches.isEmpty {
                        Text(search.isEmpty ? "No items in this category" : "No matching items")
                            .foregroundColor(VaultStyle.textSecondary).padding()
                    } else {
                        ScrollViewReader { reader in
                            ScrollView {
                                LazyVStack(spacing: 2) {
                                    ForEach(matches) { item in
                                        Button { selected = item.id } label: {
                                            HStack(spacing: 10) {
                                                VaultIcon(token: item.isToken, size: 32)
                                                VStack(alignment: .leading, spacing: 3) {
                                                    Text(item.label).font(VaultStyle.font(15, bold: true))
                                                    Text(URL(string: item.origin)?.host ?? item.origin).font(VaultStyle.font(13)).foregroundColor(VaultStyle.textSecondary)
                                                }.lineLimit(1)
                                                Spacer()
                                            }.padding(8).contentShape(Rectangle())
                                        }.buttonStyle(.plain).background(detail?.id == item.id ? VaultStyle.accentSoft : .clear)
                                            .cornerRadius(6).id(item.id)
                                    }
                                }.padding(6)
                            }.onAppear { if let selected { reader.scrollTo(selected) } }
                        }
                    }
                    Spacer(minLength: 0)
                }.frame(width: 260).background(VaultStyle.surface)
                Divider()
                VStack(alignment: .leading, spacing: 0) {
                    if !error.isEmpty { Text(error).foregroundColor(VaultStyle.danger).padding() }
                    if let item = detail {
                        VaultDetail(entry: item, reveal: { try store.reveal(item) },
                                    edit: { draft = VaultDraft(entry: item) }, remove: { deleting = item })
                            .id(item.id)
                    } else {
                        VStack(spacing: 10) {
                            Image(systemName: "lock.square.stack").font(.largeTitle).foregroundColor(VaultStyle.accent)
                            Text(entries.isEmpty ? "Your Vault is empty" : "No item selected").font(VaultStyle.font(18, bold: true))
                            if entries.isEmpty { Text("Choose New item to save a login or API token.").foregroundColor(VaultStyle.textSecondary) }
                        }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }.font(VaultStyle.font()).foregroundColor(VaultStyle.text)
            .background(VaultStyle.surface).accentColor(VaultStyle.focus).frame(minWidth: 760, minHeight: 425)
        .onAppear { if tokenSetup { draft = VaultDraft(origin: origin, endpoint: endpoint, token: true) } }
        .sheet(item: $draft) { item in
            VaultEditor(draft: item, save: { value in
                let id = try store.save(value)
                reload(); category = .all; search = ""; selected = id
                if tokenSetup { finished(true) }
            }, close: { draft = nil; if tokenSetup { finished(false) } }, fixedToken: tokenSetup)
        }
        .alert(item: $deleting) { item in
            Alert(title: Text("Delete “" + item.label + "”?"), message: Text("This permanently removes the saved credential from this Mac."),
                  primaryButton: .destructive(Text("Delete")) {
                      do { try store.remove(item); reload() } catch { self.error = "Could not delete the item from Keychain." }
                  }, secondaryButton: .cancel())
        }
    }
    private func reload() {
        do { entries = try store.entries(); error = "" }
        catch { entries = []; self.error = "Could not read Keychain. Lock and reopen your Vault to retry." }
    }
}

private struct VaultIcon: View {
    let token: Bool
    let size: CGFloat
    var body: some View {
        let color = token ? VaultStyle.accent : VaultStyle.success
        Image(systemName: token ? "terminal" : "key.fill")
            .font(.system(size: size * 0.42, weight: .medium)).foregroundColor(color)
            .frame(width: size, height: size).background(token ? VaultStyle.accentSoft : VaultStyle.surfaceSubtle).cornerRadius(size * 0.25)
    }
}

private struct VaultDetail: View {
    let entry: VaultEntry
    let reveal: () throws -> String
    let edit, remove: () -> Void
    @State private var revealed: String?
    @State private var failed = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Spacer()
                    Button("Edit") { revealed = nil; edit() }.buttonStyle(VaultButtonStyle(compact: true)).keyboardShortcut("e")
                    Menu { Button("Delete item…", action: remove) } label: { Image(systemName: "ellipsis") }
                        .fixedSize().accessibilityLabel("Item actions")
                }
                VaultIcon(token: entry.isToken, size: 48)
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.label).font(VaultStyle.font(22, bold: true))
                    Text(entry.category).foregroundColor(VaultStyle.textSecondary)
                }
                VStack(alignment: .leading, spacing: 12) {
                    field("Website", entry.origin)
                    Divider()
                    if entry.isToken { field("MCP endpoint", entry.endpoint ?? "—") }
                    else { field("Username", entry.username) }
                    Divider()
                    HStack {
                        field(entry.isToken ? "API token" : "Password", revealed ?? "••••••••••••")
                        Spacer()
                        Button {
                            if revealed != nil { revealed = nil }
                            else { do { revealed = try reveal(); failed = false } catch { failed = true } }
                        } label: { Image(systemName: revealed == nil ? "eye" : "eye.slash") }
                            .accessibilityLabel(revealed == nil ? "Reveal secret" : "Hide secret")
                    }
                    if failed { Text("Could not read this credential.").foregroundColor(VaultStyle.danger) }
                }.padding(16).background(VaultStyle.surfaceRaised).cornerRadius(8)
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(VaultStyle.border))
                Label("Stored in this Mac’s Keychain", systemImage: "lock").font(VaultStyle.font(13)).foregroundColor(VaultStyle.textSecondary)
            }.padding(24).frame(maxWidth: 740, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in revealed = nil }
        .task(id: revealed != nil) {
            guard revealed != nil else { return }
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            if !Task.isCancelled { revealed = nil }
        }
    }
    private func field(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(VaultStyle.font(13)).foregroundColor(VaultStyle.textSecondary)
            Text(verbatim: value).fixedSize(horizontal: false, vertical: true)
        }
    }
}
