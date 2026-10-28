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
                    ProgressView(busy).padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
        }
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

    private var who: String { profiles.first { $0.key == profile }?.name ?? (needs.isEmpty ? "" : "“\(needs)”") }

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
            VStack(spacing: 12) {
                ForEach(profiles, id: \.key) { p in
                    Button {
                        profile = p.key; needs = ""; done()
                    } label: {
                        Label(p.name, systemImage: p.symbol).font(.title3).frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                    }
                    .buttonStyle(.bordered)
                    .tint(p.key == profile ? .accentColor : .primary)
                }
                Text("Or describe it in your own words").font(.headline).frame(maxWidth: .infinity, alignment: .leading).padding(.top)
                TextField("e.g. I use crutches and need to get to the wardrobe", text: $words, axis: .vertical)
                    .lineLimit(2...5).textFieldStyle(.roundedBorder)
                Button("Continue") { profile = ""; needs = words; done() }
                    .buttonStyle(.borderedProminent)
                    .disabled(words.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding()
        }
        .navigationTitle("How do you get around?")
        .onAppear { words = needs }
    }
}

struct StartView: View {
    let who: String
    let changeWho: () -> Void
    let scan: () -> Void
    let sample: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "house.and.flag").font(.system(size: 64)).foregroundStyle(.tint)
            Text("Scan your room, and SpaceAble suggests how to move your furniture so you can get around it.")
                .multilineTextAlignment(.center)
            if RoomCaptureSession.isSupported {
                Button(action: scan) {
                    Label("Scan your room", systemImage: "camera.viewfinder").font(.title3).frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.borderedProminent)
            } else {
                Text("Scanning needs an iPhone or iPad with a LiDAR scanner (Pro models).")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            Button("Try a sample room", action: sample)
            Spacer()
            Button("Planning for: \(who) · Change", action: changeWho).font(.footnote)
        }
        .padding()
        .navigationTitle("SpaceAble")
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
            VStack(alignment: .leading, spacing: 16) {
                Text("Tap anything that’s wrong. Blue pieces are the ones you need to reach; the orange door is the way in.")
                    .foregroundStyle(.secondary)
                PlanView(scenario: shown, reach: draft.reach, keep: draft.keep, startDoorId: draft.startDoorId) { hit in
                    switch hit {
                    case .piece(let p): tapped = p
                    case .door(let d): door = d
                    }
                }
                ForEach(draft.warnings, id: \.self) { Label($0, systemImage: "exclamationmark.triangle").font(.footnote) }
                ForEach(shown.objects) { p in
                    Button { tapped = p } label: {
                        HStack {
                            Text(p.label)
                            Spacer()
                            if draft.reach.contains(p.id) { Text("Reach").foregroundStyle(.tint) }
                            if draft.keep.contains(p.id) || !p.movable { Image(systemName: "lock.fill").foregroundStyle(.secondary) }
                        }
                    }
                    .padding(.vertical, 4)
                }
                Button(action: looksRight) {
                    Text("Looks right").font(.title3).frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.borderedProminent)
                Button("Change how I get around", action: changeWho).font(.footnote)
            }
            .padding()
        }
        .navigationTitle("Does this look right?")
        .toolbar { Button("Back", action: back) }
        .confirmationDialog(tapped?.label ?? "", isPresented: Binding(get: { tapped != nil }, set: { if !$0 { tapped = nil } }),
                            titleVisibility: .visible, presenting: tapped) { p in
            Button(draft.reach.contains(p.id) ? "I don’t need to reach this" : "I need to reach this") { toggle(&draft.reach, p.id) }
            if p.movable {
                Button(draft.keep.contains(p.id) ? "It can be moved" : "Don’t move this") { toggle(&draft.keep, p.id) }
            }
            Button("It’s not in my room", role: .destructive) { draft.remove.insert(p.id); draft.reach.remove(p.id); draft.keep.remove(p.id) }
        }
        .confirmationDialog("Door", isPresented: Binding(get: { door != nil }, set: { if !$0 { door = nil } }), presenting: door) { d in
            Button("This is the way in") { draft.startDoorId = d.id }
        }
    }

    private func toggle(_ set: inout Set<String>, _ id: String) {
        if set.contains(id) { set.remove(id) } else { set.insert(id) }
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
            VStack(alignment: .leading, spacing: 16) {
                Text(plan.headline).font(.title3.weight(.semibold))
                if plan.options.count > 1 {
                    Picker("Option", selection: $picked) {
                        ForEach(plan.options.indices, id: \.self) { Text(plan.options[$0].label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                let option = plan.options.indices.contains(picked) ? plan.options[picked] : nil
                PlanView(scenario: plan.scenario, moves: option?.moves ?? [], routes: option?.routes ?? [],
                         reach: draft.reach, keep: draft.keep, startDoorId: draft.startDoorId)
                if let option {
                    ForEach(Array(option.steps.enumerated()), id: \.offset) { i, step in
                        Label(step, systemImage: "\(i + 1).circle.fill").font(.body)
                    }
                    Text("The blue line is the way from the door. Dashed outlines show where things were.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                DisclosureGroup("Details") {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(plan.details, id: \.self) { Text($0).font(.footnote) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                HStack {
                    Button("Scan again", action: scanAgain)
                    Spacer()
                    Button("Change how I get around", action: changeWho)
                }
                .font(.footnote)
            }
            .padding()
        }
        .navigationTitle("Your plan")
    }
}
