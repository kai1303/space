import SwiftUI
import CoreText

enum VaultStyle {
    static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let rgb = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255,
                           blue: CGFloat(rgb & 255) / 255, alpha: 1)
        })
    }

    static func registerFonts(in directory: URL) {
        for weight in [400, 700] {
            let file = directory.appendingPathComponent("lato-latin-\(weight)-normal.woff2")
            CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
        }
    }

    static let bundledFonts: Void = {
        var image = Dl_info()
        guard dladdr(#dsohandle, &image) != 0, let path = image.dli_fname else { return }
        registerFonts(in: URL(fileURLWithPath: String(cString: path)).deletingLastPathComponent())
    }()

    static func font(_ size: CGFloat = 15, bold: Bool = false) -> Font {
        .custom(bold ? "Lato-Bold" : "Lato-Regular", fixedSize: size)
    }
}

struct VaultButtonStyle: ButtonStyle {
    var primary = false
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration, primary: primary, compact: compact)
    }
    private struct Face: View {
        let configuration: ButtonStyle.Configuration
        let primary, compact: Bool
        @State private var hovered = false
        @Environment(\.isEnabled) private var enabled
        var body: some View {
            let active = hovered || configuration.isPressed
            configuration.label
                .font(VaultStyle.font(compact ? 13 : 15, bold: true))
                .padding(.horizontal, compact ? 8 : 12).frame(minHeight: compact ? 28 : 36)
                .foregroundColor(primary ? VaultStyle.onSuccess : VaultStyle.text)
                .background(primary ? (active ? VaultStyle.successHover : VaultStyle.success)
                                    : (active ? VaultStyle.surfaceHover : VaultStyle.surface))
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(primary ? .clear : VaultStyle.borderStrong))
                .opacity(enabled ? 1 : 0.45).onHover { hovered = $0 }
        }
    }
}

struct VaultPageHeader: View {
    let back: () -> Void
    var body: some View {
        HStack(spacing: 12) {
            Button(action: back) { Label("Back to Space", systemImage: "chevron.left") }
                .buttonStyle(.plain).foregroundColor(VaultStyle.sidebarText)
            Divider().frame(height: 20)
            Label("Vault", systemImage: "lock").font(VaultStyle.font(18, bold: true))
            Spacer()
        }.font(VaultStyle.font()).padding(.horizontal, 20).frame(height: 48)
            .foregroundColor(VaultStyle.text).background(VaultStyle.sidebar)
            .overlay(alignment: .bottom) { Rectangle().fill(VaultStyle.border).frame(height: 1) }
    }
}
