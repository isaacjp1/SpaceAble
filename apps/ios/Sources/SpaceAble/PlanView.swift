import SwiftUI

/// What a tap on the plan hit.
enum Hit { case piece(Piece), door(Door) }

/// The room from above: doors, labelled pieces, and for a result, where pieces were (dashed),
/// arrows to where they go, and the route from the door.
struct PlanView: View {
    let scenario: Scenario
    var moves: [Move] = []
    var routes: [[[Double]]] = []
    var reach: Set<String> = []
    var keep: Set<String> = []
    var startDoorId: String?
    var onTap: ((Hit) -> Void)?

    private var room: Room { scenario.room }
    private func moved(_ id: String) -> Move? { moves.first { $0.objectId == id } }

    /// Footprint in cm: 90/270 swap width and depth.
    private func rect(_ p: Piece, x: Double, y: Double, rotation: Int) -> CGRect {
        let turned = rotation == 90 || rotation == 270
        return CGRect(x: x, y: y, width: turned ? p.heightCm : p.widthCm, height: turned ? p.widthCm : p.heightCm)
    }
    private func now(_ p: Piece) -> CGRect {
        guard let m = moved(p.id) else { return rect(p, x: p.xCm, y: p.yCm, rotation: p.rotationDeg) }
        return rect(p, x: m.toXCm, y: m.toYCm, rotation: m.toRotationDeg)
    }
    private func line(_ d: Door) -> (CGPoint, CGPoint) {
        let w = d.clearWidthCm ?? 80, o = d.offsetCm
        switch d.wall {
        case "top": return (CGPoint(x: o, y: 0), CGPoint(x: o + w, y: 0))
        case "bottom": return (CGPoint(x: o, y: room.heightCm), CGPoint(x: o + w, y: room.heightCm))
        case "left": return (CGPoint(x: 0, y: o), CGPoint(x: 0, y: o + w))
        default: return (CGPoint(x: room.widthCm, y: o), CGPoint(x: room.widthCm, y: o + w))
        }
    }

    var body: some View {
        GeometryReader { geo in
            let scale = min(geo.size.width / room.widthCm, geo.size.height / room.heightCm)
            let size = CGSize(width: room.widthCm * scale, height: room.heightCm * scale)
            let pt = { (x: Double, y: Double) in CGPoint(x: x * scale, y: y * scale) }
            let box = { (r: CGRect) in CGRect(x: r.minX * scale, y: r.minY * scale, width: r.width * scale, height: r.height * scale) }
            Canvas { ctx, _ in
                ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(.secondarySystemBackground)))
                ctx.stroke(Path(CGRect(origin: .zero, size: size)), with: .color(.primary), lineWidth: 3)
                for d in scenario.doors {
                    let (a, b) = line(d)
                    var p = Path(); p.move(to: pt(a.x, a.y)); p.addLine(to: pt(b.x, b.y))
                    ctx.stroke(p, with: .color(d.id == startDoorId ? .orange : Color(.systemBackground)), lineWidth: 6)
                }
                for route in routes where route.count > 1 {
                    var p = Path()
                    p.addLines(route.map { pt($0[0], $0[1]) })
                    ctx.stroke(p, with: .color(.blue.opacity(0.7)), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                }
                for piece in scenario.objects {
                    let r = box(now(piece))
                    if let m = moved(piece.id) {
                        let was = box(rect(piece, x: m.fromXCm, y: m.fromYCm, rotation: m.fromRotationDeg))
                        ctx.stroke(Path(was), with: .color(.secondary), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                        var arrow = Path(); arrow.move(to: CGPoint(x: was.midX, y: was.midY)); arrow.addLine(to: CGPoint(x: r.midX, y: r.midY))
                        ctx.stroke(arrow, with: .color(.green), lineWidth: 2)
                    }
                    let tint: Color = moved(piece.id) != nil ? .green : keep.contains(piece.id) || !piece.movable ? .gray
                        : reach.contains(piece.id) ? .accentColor : .brown
                    ctx.fill(Path(roundedRect: r, cornerRadius: 3), with: .color(tint.opacity(0.35)))
                    ctx.stroke(Path(roundedRect: r, cornerRadius: 3), with: .color(tint), lineWidth: 1.5)
                    let label = piece.label + (keep.contains(piece.id) ? " 🔒" : "")
                    ctx.draw(Text(label).font(.caption2.weight(.semibold)), in: r.insetBy(dx: 2, dy: 2))
                }
            }
            .frame(width: size.width, height: size.height)
            .contentShape(Rectangle())
            .onTapGesture { at in
                guard let onTap else { return }
                let x = at.x / scale, y = at.y / scale
                if let p = scenario.objects.last(where: { now($0).insetBy(dx: -5, dy: -5).contains(CGPoint(x: x, y: y)) }) {
                    onTap(.piece(p))
                } else if let d = scenario.doors.first(where: {
                    let (a, b) = line($0)
                    return CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y).insetBy(dx: -30, dy: -30).contains(CGPoint(x: x, y: y))
                }) {
                    onTap(.door(d))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .aspectRatio(room.widthCm / room.heightCm, contentMode: .fit)
        .accessibilityElement()
        .accessibilityLabel("Floor plan with \(scenario.objects.map(\.label).joined(separator: ", "))")
    }
}
