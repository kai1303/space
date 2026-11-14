import Foundation
import Security

struct Item: Codable {
    let id: UUID
    let label: String
    let username: String
    let secret: String
    let kind: String
    let endpoint: String?
    var version: UUID? = nil
}
enum Failure: Error { case unavailable }
func readItems(_ query: [String: Any]) throws -> [Item] {
    var q = query
    q[kSecReturnData as String] = true
    var found: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &found)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let data = found as? Data else { throw Failure.unavailable }
    return try JSONDecoder().decode([Item].self, from: data)
}
func saveItems(_ items: [Item], _ query: [String: Any]) throws {
    let data = try JSONEncoder().encode(items)
    let values = [kSecValueData as String: data]
    var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
        var q = query.merging(values) { _, new in new }
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        status = SecItemAdd(q as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw Failure.unavailable }
}

func vaultQuery(_ scope: String, origin: String? = nil) -> [String: Any] {
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: "Space Personal Vault " + scope,
                                kSecAttrSynchronizable as String: false]
    if let origin { query[kSecAttrAccount as String] = origin }
    return query
}

// Keep only display metadata in the unlocked window. Load a secret on explicit reveal or save.
struct VaultEntry: Identifiable {
    let id: UUID
    let origin, label, username, kind: String
    let endpoint: String?
    let version: UUID
    var metadata: [String:String] {
        var result = ["id":id.uuidString.lowercased(), "version":version.uuidString.lowercased(),
                      "site":origin, "title":label, "kind":kind]
        if isToken { result["endpoint"] = endpoint } else { result["username"] = username }
        return result
    }
    var isToken: Bool { kind == "token" }
    var category: String { isToken ? "API token" : "Login" }
    var icon: String { isToken ? "terminal" : "key.fill" }
    init(_ item: Item, origin: String) {
        id = item.id; version = item.version ?? item.id; self.origin = origin; label = item.label
        username = item.username; kind = item.kind; endpoint = item.endpoint
    }
}

struct VaultIssue: LocalizedError {
    static let stale = VaultIssue("This item changed. Unlock again to load the latest version.")
    static let duplicate = VaultIssue("An item with this title already exists for this website.")
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

struct VaultStore {
    let scope: String
    func entries() throws -> [VaultEntry] {
        var query = vaultQuery(scope)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let rows = result as? [[String: Any]] else { throw Failure.unavailable }
        return try rows.flatMap { row -> [VaultEntry] in
            guard let site = row[kSecAttrAccount as String] as? String else { throw Failure.unavailable }
            return try readItems(vaultQuery(scope, origin: site)).map { VaultEntry($0, origin: site) }
        }.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }

    func reveal(_ entry: VaultEntry) throws -> String {
        guard let item = try readItems(vaultQuery(scope, origin: entry.origin)).first(where: { $0.id == entry.id }) else {
            throw VaultIssue("This item is no longer available.")
        }
        return item.secret
    }

    func remove(_ entry: VaultEntry, expectedVersion: UUID? = nil) throws {
        let query = vaultQuery(scope, origin: entry.origin)
        var items = try readItems(query)
        guard let index = items.firstIndex(where: { $0.id == entry.id }) else {
            if expectedVersion != nil { throw VaultIssue.stale }
            return
        }
        if let expectedVersion, (items[index].version ?? items[index].id) != expectedVersion { throw VaultIssue.stale }
        items.remove(at: index)
        if items.isEmpty {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.unavailable }
        } else { try saveItems(items, query) }
    }

    func save(_ draft: VaultDraft, expectedVersion: UUID? = nil) throws -> UUID {
        let name = draft.label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 100 else { throw VaultIssue("Enter a title of up to 100 characters.") }
        let origin = try VaultDraft.site(draft.website)
        let endpoint = draft.token && !draft.endpoint.isEmpty ? try VaultDraft.server(draft.endpoint) : nil
        let query = vaultQuery(scope, origin: origin)
        var items = try readItems(query)
        let index = items.firstIndex { $0.id == draft.id }
        if let expectedVersion {
            guard let index, (items[index].version ?? items[index].id) == expectedVersion else { throw VaultIssue.stale }
        }
        guard !draft.editing || index != nil else { throw VaultIssue("This item is no longer available.") }
        guard index != nil || items.count < 32 else { throw VaultIssue("This website already has 32 saved items.") }
        let username = draft.token ? "" : draft.username
        guard draft.token || !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              username.utf8.count <= 1024 else { throw VaultIssue("Enter a username or email address.") }
        let secret = draft.secret.isEmpty ? index.map { items[$0].secret } ?? "" : draft.secret
        guard !secret.isEmpty, secret.utf8.count <= 4096 else { throw VaultIssue("Enter a password or token of up to 4096 bytes.") }
        let kind = draft.token ? "token" : "login"
        guard !items.contains(where: { $0.id != draft.id && $0.label == name && $0.kind == kind && $0.endpoint == endpoint }) else {
            throw VaultIssue.duplicate
        }
        let item = Item(id: draft.id, label: name, username: username, secret: secret, kind: kind, endpoint: endpoint, version: UUID())
        if let index { items[index] = item } else { items.append(item) }
        try saveItems(items, query)
        return draft.id
    }
}

struct VaultDraft: Identifiable {
    let id: UUID
    let editing: Bool
    var token: Bool
    var label, website, username, secret, endpoint: String
    init(entry: VaultEntry? = nil, origin: String = "", endpoint: String = "", token: Bool = false) {
        id = entry?.id ?? UUID(); editing = entry != nil
        self.token = entry?.isToken ?? token; label = entry?.label ?? ""
        website = entry?.origin ?? origin; username = entry?.username ?? ""; secret = ""
        self.endpoint = entry?.endpoint ?? endpoint
    }
    static func https(_ text: String) throws -> URLComponents {
        let input = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard input.utf8.count <= 2000, !input.contains("\\"), !input.contains(where: { $0.isWhitespace }),
              var url = URLComponents(string: input), url.scheme?.lowercased() == "https",
              let host = url.url?.host, !host.isEmpty, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, (1...65535).contains(url.port ?? 443) else {
            throw VaultIssue("Enter an HTTPS address without credentials, a query, or a fragment.")
        }
        url.scheme = "https"; url.host = host.lowercased()
        if url.port == 443 { url.port = nil }
        return url
    }
    static func site(_ text: String) throws -> String {
        var url = try https(text)
        guard ["", "/"].contains(url.path) else { throw VaultIssue("Use the website origin, for example https://linear.app.") }
        url.path = ""
        guard let value = url.url?.absoluteString else { throw VaultIssue("Check the website address.") }
        return value
    }
    static func server(_ text: String) throws -> String {
        var url = try https(text)
        if url.path.isEmpty { url.path = "/" }
        guard let value = url.url?.absoluteString else { throw VaultIssue("Check the MCP endpoint.") }
        return value
    }
}
