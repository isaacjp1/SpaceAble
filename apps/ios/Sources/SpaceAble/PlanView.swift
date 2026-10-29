import SwiftUI

/// What a tap on the plan hit.
enum Hit { case piece(Piece), door(Door) }

/// The room from above. Checking: the places to reach. Result: the route from the door, moved pieces,
/// and dashed outlines where they were. The way in is the dark door; locks mark pieces that stay put.
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
                let floor = Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 6)
                ctx.fill(floor, with: .color(.raised))
                ctx.stroke(floor, with: .color(.stone), lineWidth: 4)
                for d in scenario.doors {
                    let (a, b) = line(d)
                    var p = Path(); p.move(to: pt(a.x, a.y)); p.addLine(to: pt(b.x, b.y))
                    let way = d.id == startDoorId
                    ctx.stroke(p, with: .color(way ? .ink : .raised), style: StrokeStyle(lineWidth: way ? 8 : 5, lineCap: way ? .round : .butt))
                }
                for route in routes where route.count > 1 {
                    var p = Path()
                    p.addLines(route.map { pt($0[0], $0[1]) })
                    ctx.stroke(p, with: .color(.terracotta), style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
                }
                for piece in scenario.objects {
                    let r = box(now(piece))
                    let move = moved(piece.id)
                    if let m = move {
                        let was = box(rect(piece, x: m.fromXCm, y: m.fromYCm, rotation: m.fromRotationDeg))
                        ctx.stroke(Path(roundedRect: was, cornerRadius: 6), with: .color(.stone), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                        arrow(ctx, from: CGPoint(x: was.midX, y: was.midY), to: CGPoint(x: r.midX, y: r.midY))
                    }
                    let tint: Color? = move != nil ? .sage : reach.contains(piece.id) ? .terracotta : nil
                    let shape = Path(roundedRect: r, cornerRadius: 6)
                    ctx.fill(shape, with: .color(tint?.opacity(0.16) ?? .card))
                    ctx.stroke(shape, with: .color(tint ?? .stone), lineWidth: tint == nil ? 1.5 : 2.5)
                    let label = keep.contains(piece.id) || !piece.movable
                        ? Text("\(Image(systemName: "lock.fill")) \(piece.label)") : Text(piece.label)
                    ctx.draw(label.font(.caption2.weight(.semibold)).foregroundStyle(Color.ink), in: r.insetBy(dx: 3, dy: 3))
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
        .accessibilityLabel("Floor plan")
        .accessibilityValue(scenario.objects.map(\.label).joined(separator: ", "))
    }

    private func arrow(_ ctx: GraphicsContext, from a: CGPoint, to b: CGPoint) {
        let len = hypot(b.x - a.x, b.y - a.y)
        guard len > 12 else { return }
        let ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, head: CGFloat = 9
        var p = Path()
        p.move(to: a); p.addLine(to: b)
        p.move(to: CGPoint(x: b.x - head * (ux - uy * 0.6), y: b.y - head * (uy + ux * 0.6))); p.addLine(to: b)
        p.addLine(to: CGPoint(x: b.x - head * (ux + uy * 0.6), y: b.y - head * (uy - ux * 0.6)))
        ctx.stroke(p, with: .color(.sage), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
    }
}

/// What the plan's colours and marks mean, so colour is never the only cue.
struct Legend: View {
    let items: [(text: String, symbol: String, tint: Color)]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { chips }
            VStack(alignment: .leading, spacing: 6) { chips }
        }
        .accessibilityElement(children: .combine)
    }

    private var chips: some View {
        ForEach(items, id: \.text) { Chip(text: $0.text, symbol: $0.symbol, tint: $0.tint) }
    }
}
