import RoomPlan
import SwiftUI

/// How a person gets around. The keys and wording match PROFILES in apps/web/lib/simple.ts.
let profiles: [(key: String, name: String, symbol: String)] = [
    ("wheelchair", "Wheelchair", "figure.roll"),
    ("power_chair", "Power chair or scooter", "figure.roll.runningpace"),
    ("walker", "Walker or rollator", "figure.walk.motion"),
    ("crutches", "Crutches", "figure.walk"),
    ("cane", "Cane, or unsteady on my feet", "figure.stand"),
]

/// Who → scan → "Looks right?" → the proposed rearrangement.
struct ContentView: View {
    @AppStorage("profile") private var profile = ""
    @AppStorage("needs") private var needs = "" // their own words, when they described it instead
    @State private var choosing = false
    @State private var scanning = false
    @State private var draft: Draft?
    @State private var plan: Plan?
    @State private var busy: String?
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Group {
                if choosing || (profile.isEmpty && needs.isEmpty) {
                    WhoView(profile: $profile, needs: $needs) { choosing = false; plan = nil }
                } else if let plan, let draft {
                    ResultView(plan: plan, draft: draft, scanAgain: { self.plan = nil; self.draft = nil },
                               changeWho: { choosing = true })
                } else if let d = draft {
                    // falls back to the last draft while "Back" removes this screen, instead of unwrapping nil
                    CheckView(draft: Binding(get: { draft ?? d }, set: { draft = $0 }), back: { draft = nil },
                              changeWho: { choosing = true }) { Task { await run() } }
                } else {
                    StartView(who: who, changeWho: { choosing = true }, scan: { scanning = true },
                              sample: { Task { await load(nil) } })
                }
            }
            .disabled(busy != nil)
            .overlay {
                if let busy {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text(busy)
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.ink)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 16)
                    .background(Color.raised, in: Capsule())
                    .shadow(color: .black.opacity(0.12), radius: 18, y: 8)
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .tint(.terracotta)
        .fullScreenCover(isPresented: $scanning) {
            RoomScanner { room in
                scanning = false
                if let room { Task { await load(room) } }
            }
            .ignoresSafeArea()
        }
        .alert("SpaceAble", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK") {}
        } message: {
            Text(problem ?? "")
        }
    }

    private var who: (name: String, symbol: String) {
        profiles.first { $0.key == profile }.map { ($0.name, $0.symbol) } ?? (needs, "text.bubble")
    }

    private func load(_ room: CapturedRoom?) async {
        busy = room == nil ? "Opening the sample room…" : "Reading your scan…"
        defer { busy = nil }
        do { draft = try await API.draft(scan: room) } catch { problem = error.localizedDescription }
    }

    private func run() async {
        guard let draft else { return }
        busy = "Finding a better layout…"
        defer { busy = nil }
        do { plan = try await API.plan(draft, profile: profile, description: needs) } catch { problem = error.localizedDescription }
    }
}

struct WhoView: View {
    @Binding var profile: String
    @Binding var needs: String
    let done: () -> Void
    @State private var words = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text("SpaceAble plans enough room for the way you move. You can change this at any time.")
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
                VStack(spacing: 10) {
                    ForEach(profiles, id: \.key) { p in
                        let selected = p.key == profile
                        Button {
                            profile = p.key; needs = ""; done()
                        } label: {
                            HStack(spacing: 14) {
                                Image(systemName: p.symbol)
                                    .font(.title3)
                                    .foregroundStyle(Color.terracotta)
                                    .frame(width: 36)
                                Text(p.name).font(.body.weight(.medium)).foregroundStyle(Color.ink)
                                Spacer(minLength: 8)
                                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(selected ? Color.terracotta : Color.stone)
                            }
                            .padding(.horizontal, 20)
                            .padding(.vertical, 12)
                            .frame(minHeight: 60)
                            .background(Color.card, in: Capsule())
                            .overlay { if selected { Capsule().strokeBorder(Color.terracotta, lineWidth: 2) } }
                            .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("Or describe it").font(.headline).foregroundStyle(Color.ink)
                    TextField("Description", text: $words,
                              prompt: Text("For example: I use crutches and need to reach the wardrobe").foregroundStyle(Color.muted),
                              axis: .vertical)
                        .lineLimit(3...6)
                        .foregroundStyle(Color.ink)
                        .padding(16)
                        .background(Color.raised, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.stone))
                    Label("You can dictate with the microphone on the keyboard.", systemImage: "mic")
                        .font(.footnote)
                        .foregroundStyle(Color.muted)
                    Button("Continue") { profile = ""; needs = words; done() }
                        .buttonStyle(.pill)
                        .disabled(words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .padding(.top, 6)
                }
                Text("These are planning defaults, not clinical advice.")
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
            }
            .padding(20)
        }
        .screen("How do you get around?")
        .onAppear { words = needs }
    }
}

struct StartView: View {
    let who: (name: String, symbol: String)
    let changeWho: () -> Void
    let scan: () -> Void
    let sample: () -> Void
    @ScaledMetric private var hero = 108.0

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                VStack(spacing: 16) {
                    Image(systemName: "house")
                        .font(.system(size: hero * 0.42, weight: .medium))
                        .foregroundStyle(Color.terracotta)
                        .frame(width: hero, height: hero)
                        .background(Color.card, in: Circle())
                        .accessibilityHidden(true)
                    Text("Make room to move")
                        .font(.largeTitle.bold())
                        .foregroundStyle(Color.ink)
                    Text("Scan a room, and SpaceAble suggests what to move so you can get around it.")
                        .foregroundStyle(Color.muted)
                    Button(action: changeWho) {
                        HStack(spacing: 6) {
                            Chip(text: "Planning for \(who.name)", symbol: who.symbol, tint: .ink).lineLimit(1)
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Color.muted)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Change how you get around")
                }
                .multilineTextAlignment(.center)
                .padding(.top, 12)

                if RoomCaptureSession.isSupported {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Before you scan").font(.headline).foregroundStyle(Color.ink)
                        tip("figure.walk", "Walk slowly along every wall.")
                        tip("door.left.hand.open", "Include the door you come in through.")
                        tip("lightbulb", "Turn the lights on.")
                    }
                    .card()
                    Button(action: scan) { Label("Scan your room", systemImage: "camera.viewfinder") }
                        .buttonStyle(.pill)
                } else {
                    tip("exclamationmark.circle", "Scanning needs an iPhone or iPad with a LiDAR scanner, such as a Pro model.")
                        .card()
                }
                Button(action: sample) { Label("Try a sample room", systemImage: "square.grid.2x2") }
                    .buttonStyle(PillButtonStyle(filled: !RoomCaptureSession.isSupported))
            }
            .padding(20)
        }
        .screen("SpaceAble")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func tip(_ symbol: String, _ text: String) -> some View {
        Label {
            Text(text).foregroundStyle(Color.ink)
        } icon: {
            Image(systemName: symbol).foregroundStyle(Color.terracotta)
        }
        .font(.subheadline)
    }
}

struct CheckView: View {
    @Binding var draft: Draft
    let back: () -> Void
    let changeWho: () -> Void
    let looksRight: () -> Void
    @State private var tapped: Piece?
    @State private var door: Door?

    private var shown: Scenario {
        Scenario(room: draft.scenario.room, doors: draft.scenario.doors, objects: draft.scenario.objects.filter { !draft.remove.contains($0.id) })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Tap a piece to change it, or a door to make it the way in.")
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
                VStack(spacing: 14) {
                    PlanView(scenario: shown, reach: draft.reach, keep: draft.keep, startDoorId: draft.startDoorId) { hit in
                        switch hit {
                        case .piece(let p): tapped = p
                        case .door(let d): door = d
                        }
                    }
                    Legend(items: [("To reach", "scope", .terracotta), ("Stays put", "lock.fill", .muted), ("Way in", "door.left.hand.open", .ink)])
                }
                .card(padding: 14)
                if !draft.warnings.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(draft.warnings, id: \.self) { w in
                            Label {
                                Text(w).foregroundStyle(Color.ink)
                            } icon: {
                                Image(systemName: "exclamationmark.triangle").foregroundStyle(Color.terracotta)
                            }
                            .font(.footnote)
                        }
                    }
                    .card()
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text("In this room").font(.headline).foregroundStyle(Color.ink).padding(.bottom, 6)
                    ForEach(Array(shown.objects.enumerated()), id: \.element.id) { i, p in
                        if i > 0 { Rectangle().fill(Color.hairline).frame(height: 1) }
                        Button { tapped = p } label: {
                            HStack(spacing: 8) {
                                Text(p.label).foregroundStyle(Color.ink)
                                Spacer(minLength: 8)
                                if draft.reach.contains(p.id) { Chip(text: "Reach", symbol: "scope", tint: .terracotta) }
                                if !p.movable { Chip(text: "Fixed", symbol: "lock.fill") }
                                else if draft.keep.contains(p.id) { Chip(text: "Stays", symbol: "lock.fill") }
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.muted)
                            }
                            .frame(minHeight: 50)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .card()
            }
            .padding(20)
        }
        .safeAreaInset(edge: .bottom) {
            Button(action: looksRight) { Label("Looks right", systemImage: "checkmark") }
                .buttonStyle(.pill)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .background(Color.canvas)
        }
        .screen("Check your room")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Button("Back", action: back) }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Change how I get around", systemImage: "figure.roll", action: changeWho)
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
        .sheet(item: $tapped) { PieceSheet(piece: $0, draft: $draft) }
        .confirmationDialog("Door", isPresented: Binding(get: { door != nil }, set: { if !$0 { door = nil } }), presenting: door) { d in
            Button("Use as the way in") { draft.startDoorId = d.id }
        }
    }
}

/// One piece's settings: whether the person needs to reach it, whether it stays put, or that it isn't there.
struct PieceSheet: View {
    let piece: Piece
    @Binding var draft: Draft
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle(isOn: member(\.reach)) { Label("I need to reach this", systemImage: "scope") }
                    if piece.movable {
                        Toggle(isOn: member(\.keep)) { Label("Keep it where it is", systemImage: "lock") }
                    } else {
                        Label("Fixed in place", systemImage: "lock.fill").foregroundStyle(Color.muted)
                    }
                } footer: {
                    Text("SpaceAble may move anything you don’t keep in place.").foregroundStyle(Color.muted)
                }
                .listRowBackground(Color.card)
                Section {
                    Button(role: .destructive) {
                        draft.remove.insert(piece.id); draft.reach.remove(piece.id); draft.keep.remove(piece.id)
                        dismiss()
                    } label: {
                        Label("It’s not in my room", systemImage: "trash").foregroundStyle(Color.danger)
                    }
                }
                .listRowBackground(Color.card)
            }
            .foregroundStyle(Color.ink)
            .scrollContentBackground(.hidden)
            .background(Color.canvas)
            .navigationTitle(piece.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .tint(.terracotta)
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(32)
        .presentationBackground(Color.canvas)
    }

    private func member(_ set: WritableKeyPath<Draft, Set<String>>) -> Binding<Bool> {
        Binding(get: { draft[keyPath: set].contains(piece.id) },
                set: { if $0 { draft[keyPath: set].insert(piece.id) } else { draft[keyPath: set].remove(piece.id) } })
    }
}

struct ResultView: View {
    let plan: Plan
    let draft: Draft
    let scanAgain: () -> Void
    let changeWho: () -> Void
    @State private var picked = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Image(systemName: plan.options.isEmpty ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                        .foregroundStyle(plan.options.isEmpty ? Color.terracotta : Color.sage)
                        .accessibilityHidden(true)
                    Text(plan.headline).foregroundStyle(Color.ink)
                }
                .font(.title3.weight(.semibold))
                .card()
                if plan.options.count > 1 {
                    Picker("Option", selection: $picked) {
                        ForEach(plan.options.indices, id: \.self) { Text(plan.options[$0].label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                let option = plan.options.indices.contains(picked) ? plan.options[picked] : nil
                VStack(spacing: 14) {
                    PlanView(scenario: plan.scenario, moves: option?.moves ?? [], routes: option?.routes ?? [],
                             keep: draft.keep, startDoorId: draft.startDoorId)
                    Legend(items: [("Your way", "point.topleft.down.to.point.bottomright.curvepath", .terracotta),
                                   ("Moved", "arrow.up.and.down.and.arrow.left.and.right", .sage),
                                   ("Was here", "square.dashed", .muted)])
                }
                .card(padding: 14)
                if let option {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("What to do").font(.headline).foregroundStyle(Color.ink)
                        ForEach(Array(option.steps.enumerated()), id: \.offset) { i, step in
                            Label {
                                Text(step).foregroundStyle(Color.ink)
                            } icon: {
                                Image(systemName: "\(i + 1).circle.fill").foregroundStyle(Color.terracotta)
                            }
                        }
                    }
                    .card()
                }
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(plan.details, id: \.self) { Text($0) }
                    }
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 10)
                } label: {
                    Label("Details", systemImage: "ruler").font(.headline).foregroundStyle(Color.ink)
                }
                .card()
                VStack(spacing: 12) {
                    Button(action: scanAgain) { Label("Scan again", systemImage: "camera.viewfinder") }
                        .buttonStyle(.pillOutline)
                    Button("Change how I get around", action: changeWho)
                        .font(.subheadline.weight(.medium))
                        .frame(minHeight: 44)
                }
            }
            .padding(20)
        }
        .screen("Your plan")
    }
}
