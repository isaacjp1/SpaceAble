// The iPhone app's simple flow: profiles, default places to reach, plain-language results, and its
// two routes with the planner and Meta mocked at the fetch layer.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as draft } from "@/app/api/app/draft/route";
import { POST as plan } from "@/app/api/app/plan/route";
import { type Furniture, type OptimizationResult, RoomScenarioSchema, type ValidationResult } from "@/lib/schema";
import { PROFILES, approachSide, defaultDoor, defaultReach, moveStep, planScenario, summarize, wallNames } from "@/lib/simple";
import { box, buildScan } from "./scan";

const sample = RoomScenarioSchema.parse(JSON.parse(readFileSync(
  path.join(import.meta.dirname, "../../../shared/fixtures/canonical-bedroom.json"), "utf8")));
const room = { width_cm: 400, height_cm: 300 };
const piece = (o: Partial<Furniture>): Furniture => ({ id: "p", label: "Piece", kind: "other", x_cm: 0, y_cm: 0,
  width_cm: 100, height_cm: 50, rotation_deg: 0, movable: true, confirmed: false, label_source: "ai-inferred", to_place: false, ...o });
const choices = { profile: "wheelchair" as const, reach: ["bed", "desk"], keep: ["dresser"], remove: [], startDoorId: null };

const validation = (checks: { id: string; status: ValidationResult["status"] }[] = []): ValidationResult => ({
  status: "fail", checks: checks.map((c) => ({ ...c, required: true, measured_cm: null, required_cm: null, message: c.id, object_ids: [] })),
  routes: [], turning_zones: [], reachable_area: [], assumptions: [], warnings: [], grid_cm: 5, elapsed_ms: 1, widest_route_cm: null,
});
const result = (o: Partial<OptimizationResult> = {}): OptimizationResult => ({
  status: "solutions_found", message: "Found 1 verified alternative.", baseline: validation(), warnings: [], alternatives: [],
  search: { grid_spacing_cm: 20, time_limit_s: 8, elapsed_s: 1, combinations_considered: 1, candidates_tested: 1, exhaustive: true }, ...o,
});
const deskToBottom = { object_id: "desk", from_x_cm: 115, from_y_cm: 35, from_rotation_deg: 0, to_x_cm: 115, to_y_cm: 295,
  to_rotation_deg: 0, distance_cm: 260 };
const solved = result({ alternatives: [{ id: "alternative-1", layout: { object_positions: [] }, moves: [deskToBottom],
  validation: { ...validation(), status: "pass", widest_route_cm: 104,
    routes: [{ destination_id: "reach-desk", door_id: "door-1", status: "pass", start: [47, 80], target_rect: null,
      polyline: [[47, 80], [170, 250]], length_cm: 200, min_clearance_cm: 50 }] },
  cost: { moved_objects: 1, displacement_cm: 260, route_length_cm: 200, total_score: 1 }, best_for: ["fewest_changes", "widest_route"] }] });

describe("profiles and defaults", () => {
  it("reaches furniture and fixtures, not chairs, TVs or fireplaces", () => {
    expect(defaultReach(sample)).toEqual(["bed", "desk", "dresser"]);
    const s = { ...sample, objects: [piece({ id: "c", kind: "chair" }), piece({ id: "tv", label: "Television" }),
      piece({ id: "wc", kind: "obstacle", label: "Toilet" }), piece({ id: "f", kind: "obstacle", label: "Fireplace" })] };
    expect(defaultReach(s)).toEqual(["wc"]);
  });

  it("picks the widest door as the way in", () => {
    const narrow = { ...sample.doors[0], id: "closet", clear_width_cm: 60 };
    expect(defaultDoor({ ...sample, doors: [narrow, sample.doors[0]] })).toBe("door-1");
  });

  it("puts the zone on the side with the most floor, in the piece's own frame", () => {
    expect(approachSide(piece({ x_cm: 150 }), room)).toBe("bottom"); // against the top wall
    // turned 90° against the left wall: the open side is the world's right, the piece's top
    expect(approachSide(piece({ y_cm: 100, rotation_deg: 90 }), room)).toBe("top");
    // a bed against the right wall only offers its long sides; the left one has the floor
    expect(approachSide(piece({ kind: "bed", x_cm: 250, width_cm: 150, height_cm: 200 }), room)).toBe("left");
  });

  it("applies the profile, confirms everything and makes one required zone per piece to reach", () => {
    const s = planScenario(sample, { ...choices, remove: ["dresser"] });
    expect(s.requirements).toMatchObject({ route_width_cm: 91.44, door_min_clear_width_cm: 81.28, turning_diameter_cm: 152.4,
      required_destination_ids: ["reach-bed", "reach-desk"], locked_object_ids: [], start_door_id: "door-1" });
    expect(s.objects.map((o) => o.id)).toEqual(["bed", "desk"]);
    expect([...s.objects, ...s.doors].every((x) => x.confirmed)).toBe(true);
    expect(s.destinations).toMatchObject([
      { object_id: "bed", side: "left", approach_width_cm: 121.92, approach_depth_cm: 76.2 }, // side-on
      { object_id: "desk", side: "bottom", approach_width_cm: 76.2, approach_depth_cm: 121.92 }, // forward
    ]);
    expect(planScenario(sample, { ...choices, profile: "cane" }).requirements)
      .toMatchObject({ route_width_cm: 75, turning_diameter_cm: null, locked_object_ids: ["dresser"] });
    expect(() => RoomScenarioSchema.parse(s)).not.toThrow();
  });
});

describe("plain words", () => {
  const s = planScenario(sample, choices);

  it("names walls as you see them coming in through the door (on the left wall here)", () => {
    expect(wallNames(s)).toEqual({ left: "the wall with the door", right: "the wall opposite the door",
      top: "the wall on your left as you come in", bottom: "the wall on your right as you come in" });
  });

  it("describes moves and turns without measurements", () => {
    const desk = s.objects.find((o) => o.id === "desk")!;
    expect(moveStep(deskToBottom, desk, s)).toBe("Move the desk against the wall on your right as you come in");
    expect(moveStep({ ...deskToBottom, to_y_cm: 35, to_rotation_deg: 90 }, desk, s)).toBe("Turn the desk a quarter turn");
    expect(moveStep({ ...deskToBottom, to_x_cm: 300, to_y_cm: 100, to_rotation_deg: 180 }, desk, s))
      .toBe("Move the desk toward the wall opposite the door, and turn it around");
  });

  it("leads with a headline for each outcome", () => {
    const sum = summarize(s, solved, "wheelchair");
    expect(sum.headline).toBe("Move 1 thing and you can get from the door to the bed and the desk with a wheelchair.");
    expect(sum.options).toMatchObject([{ label: "Best option", steps: ["Move the desk against the wall on your right as you come in"],
      routes: [[[47, 80], [170, 250]]] }]);
    expect(sum.details.join(" ")).toContain("paths stay at least 104 cm wide");

    const current = { ...solved.alternatives[0], id: "current", moves: [] };
    expect(summarize(s, result({ alternatives: [current] }), "crutches").headline)
      .toBe("Your room already works with crutches. Nothing needs to move.");
    expect(summarize(s, result({ status: "discretized_search_infeasible",
      baseline: validation([{ id: "turning-space", status: "fail" }]) }), "wheelchair").headline)
      .toBe("The room is too small to turn a wheelchair around in, whatever you move.");
    expect(summarize(s, result({ status: "no_solution_found_within_budget" }), "walker").headline).toMatch(/ran out of time/);
    expect(summarize(s, solved, "wheelchair", true).headline)
      .toMatch(/^The doorway looks narrower than a wheelchair needs\. .* Inside the room: move 1 thing/);
  });
});

// ---- routes --------------------------------------------------------------------------------

const post = (url: string, body: unknown) => new Request(`http://app${url}`, { method: "POST", body: JSON.stringify(body) });

/** The planner answers optimize with `replies` in order; Meta answers with a record_needs call. */
function mock(replies: OptimizationResult[], needs?: object) {
  const calls: { url: string; body: { scenario: { requirements: Record<string, unknown> } } }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (String(url).includes("/v1/planner/optimize")) return Response.json(replies.shift());
    return Response.json({ id: "c", object: "chat.completion", created: 0, model: "muse-spark-1.3",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "t", type: "function", function: { name: "record_needs", arguments: JSON.stringify(needs) } }] } }] });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/app/draft", () => {
  it("returns the sample room without a scan, with places to reach and the way in", async () => {
    const body = await (await draft(post("/api/app/draft", {}))).json();
    expect(body).toMatchObject({ scenario: { id: "canonical-bedroom" }, reach: ["bed", "desk", "dresser"], start_door_id: "door-1" });
  });

  it("converts a scan, and turns unusable scans into a message to scan again", async () => {
    const scan = buildScan({ walls: box(4, 3), doors: [{ at: [0, 1], yaw: 270, size: [0.9, 2, 0] }],
      objects: [{ category: "bed", at: [2, 1.5], size: [1.4, 0.5, 2] }, { category: "storage", at: [3.5, 0.3], size: [1, 2, 0.5] }] });
    const body = await (await draft(post("/api/app/draft", { scan }))).json();
    expect(body.scenario.objects.map((o: Furniture) => [o.kind, o.confirmed])).toEqual([["bed", false], ["wardrobe", false]]);
    expect(body.reach).toEqual(["bed-1", "storage-1"]);

    const noDoor = await draft(post("/api/app/draft", { scan: buildScan({ walls: box(4, 3) }) }));
    expect(noDoor.status).toBe(400);
    expect((await noDoor.json()).error.message).toMatch(/couldn't find the doorway/);
    const bad = await draft(post("/api/app/draft", { scan: { walls: "nope" } }));
    expect(bad.status).toBe(400);
  });
});

describe("POST /api/app/plan", () => {
  it("plans with the tapped profile and answers in plain words", async () => {
    const calls = mock([solved]);
    const res = await plan(post("/api/app/plan", { scenario: sample, profile: "wheelchair", reach: ["bed", "desk"] }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(calls[0].body.scenario.requirements).toMatchObject({ route_width_cm: PROFILES.wheelchair.route, required_destination_ids: ["reach-bed", "reach-desk"] });
    expect(body).toMatchObject({ profile: "wheelchair", headline: expect.stringMatching(/^Move 1 thing/), scenario: { id: "canonical-bedroom" } });
  });

  it("plans the furniture with the door as it is when the door is too narrow, and says so", async () => {
    const narrow = result({ status: "discretized_search_infeasible", baseline: validation([{ id: "door-clearance", status: "fail" }]) });
    const calls = mock([narrow, solved]);
    const body = await (await plan(post("/api/app/plan", { scenario: sample, profile: "power_chair", reach: ["desk"] }))).json();
    expect(calls.map((c) => c.body.scenario.requirements.door_min_clear_width_cm)).toEqual([81.28, 90]);
    expect(body.headline).toMatch(/^The doorway looks narrower than a power chair or scooter needs/);
  });

  it("reads a description with Muse; a tapped profile wins over it", async () => {
    vi.stubEnv("MODEL_API_KEY", "test-key");
    let calls = mock([solved], { profile: "crutches", reach: ["bed"], keep: ["dresser"] });
    await plan(post("/api/app/plan", { scenario: sample, description: "I'm on crutches, don't move the dresser", reach: ["desk"] }));
    expect(calls[1].body.scenario.requirements).toMatchObject({ route_width_cm: 90, locked_object_ids: ["dresser"],
      required_destination_ids: ["reach-bed", "reach-desk"] });

    calls = mock([solved], { profile: "crutches", reach: [], keep: [] });
    await plan(post("/api/app/plan", { scenario: sample, profile: "cane", description: "crutches" }));
    expect(calls[1].body.scenario.requirements.route_width_cm).toBe(75);
  });

  it("rejects unknown ids and a missing profile before calling anyone", async () => {
    const calls = mock([]);
    vi.stubEnv("MODEL_API_KEY", "");
    expect((await plan(post("/api/app/plan", { scenario: sample, description: "wheelchair" }))).status).toBe(400);
    expect((await plan(post("/api/app/plan", { scenario: sample, profile: "cane", keep: ["sofa"] }))).status).toBe(422);
    expect((await plan(post("/api/app/plan", { scenario: sample, profile: "cane", start_door_id: "back" }))).status).toBe(422);
    expect(calls).toEqual([]);
  });
});
