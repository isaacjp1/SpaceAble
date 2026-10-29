import SwiftUI
import UIKit

// Warm stone and cream, light and dark. Every pair the app uses meets WCAG 2.x: 7:1 for primary text,
// 4.5:1 for other text, 3:1 for graphics and field borders. `python3 check_contrast.py` re-checks
// after any change to these values.
extension Color {
    static let canvas = Color(light: 0xF7F2EA, dark: 0x1A1714)     // screen background, cream
    static let card = Color(light: 0xEFE8DD, dark: 0x25211D)       // grouped content, stone
    static let raised = Color(light: 0xFFFCF7, dark: 0x2F2A25)     // the plan's floor, fields, chips
    static let hairline = Color(light: 0xDDD3C5, dark: 0x443D35)   // decorative separators only
    static let ink = Color(light: 0x211C17, dark: 0xF4EEE5)        // primary text
    static let muted = Color(light: 0x5F574E, dark: 0xB5AB9E)      // secondary text
    static let stone = Color(light: 0x7A7067, dark: 0x9C9287)      // walls, outlines, field borders
    static let terracotta = Color(light: 0x9E4421, dark: 0xEE9C6C) // accent: actions, places to reach, route
    static let onAccent = Color(light: 0xFFFFFF, dark: 0x1A1714)   // text on terracotta
    static let sage = Color(light: 0x3B6B44, dark: 0x8FC79A)       // success, moved furniture
    static let danger = Color(light: 0xA3261D, dark: 0xFF9C8F)     // destructive actions

    init(light: UInt32, dark: UInt32) {
        func rgb(_ v: UInt32) -> UIColor {
            UIColor(red: CGFloat(v >> 16 & 0xFF) / 255, green: CGFloat(v >> 8 & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
        }
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
    }
}

/// A full-width capsule: the screen's main action (filled) or an alternative to it (outlined).
struct PillButtonStyle: ButtonStyle {
    var filled = true
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 52)
            .padding(.horizontal, 20)
            .foregroundStyle(filled ? Color.onAccent : Color.ink)
            .background(filled ? Color.terracotta : Color.raised, in: Capsule())
            .overlay { if !filled { Capsule().strokeBorder(Color.stone) } }
            .contentShape(Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.45) // WCAG exempts disabled controls
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PillButtonStyle {
    static var pill: PillButtonStyle { PillButtonStyle() }
    static var pillOutline: PillButtonStyle { PillButtonStyle(filled: false) }
}

/// A small capsule label: a piece's state, the person's profile, a legend entry.
struct Chip: View {
    let text: String
    let symbol: String
    var tint = Color.muted

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.caption.weight(.medium))
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Color.raised, in: Capsule())
    }
}

extension View {
    /// Grouped content on a soft stone card.
    func card(padding: CGFloat = 18) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    /// A screen on the cream canvas, with a matching navigation bar.
    func screen(_ title: String) -> some View {
        self.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.canvas)
            .navigationTitle(title)
            .toolbarBackground(Color.canvas, for: .navigationBar)
    }
}
