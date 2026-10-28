import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AssistantRun, applyChanges, assistantTools, statedNumbers, summarizeRun, templateAnswer,
} from "@/lib/assistant";
import { type OptimizationResult, RoomScenarioSchema, type ValidationResult } from "@/lib/schema";

const scenario = RoomScenarioSchema.parse(JSON.parse(readFileSync(
  path.join(import.meta.dirname, "../../../shared/fixtures/canonical-bedroom.json"), "utf8")));
const keep = { route_width_cm: null, turning_diameter_cm: null, locked_object_ids: null,
  required_destination_ids: null, remove_object_ids: [], add_furniture: [] };
const said = (...texts: string[]) => statedNumbers(texts);

describe("the person's numbers", () => {
  it("include centimetre equivalents of inches, feet and metres", () => {
    expect(said("I need 36 inches")).toContain(91.44);
    expect(said("about 1 metre")).toContain(100);
    expect(said("3 ft")).toContain(91.44);
  });
});

describe("applying a tool call", () => {
  it("accepts a stated width, keeps the room otherwise, and describes the change", () => {
    const r = applyChanges(scenario, "find_layouts",
      { ...keep, route_width_cm: 91.44, locked_object_ids: ["bed", "dresser"] }, said("I need 36 inches"));
    expect(r.ok && r.changes).toEqual(["Route width 91.44 cm", "Kept in place: Bed, Dresser"]);
    expect(r.ok && r.scenario.requirements.route_width_cm).toBe(91.44);
    expect(scenario.requirements.route_width_cm).toBe(80); // the real room is untouched
  });

  it("refuses widths and sizes the person never stated, so Muse has to ask", () => {
    const wider = applyChanges(scenario, "find_layouts", { ...keep, route_width_cm: 100 }, said("make it wider"));
    expect(wider).toEqual({ ok: false, error: expect.stringContaining("Not stated by the person: route_width_cm 100") });
    const shelf = { label: "Shelf", kind: "shelf", width_cm: 120, depth_cm: 30, approach_side: null };
    const r = applyChanges(scenario, "find_layouts", { ...keep, add_furniture: [shelf] }, said("would a shelf fit?"));
    expect(r.ok).toBe(false);
    // repeating the current width is not a new measurement
    expect(applyChanges(scenario, "check_layout", { ...keep, route_width_cm: 80 }, []).ok).toBe(true);
  });

  it("rejects unknown furniture", () => {
    expect(applyChanges(scenario, "check_layout", { ...keep, remove_object_ids: ["piano"] }, []))
      .toEqual({ ok: false, error: expect.stringContaining("Unknown id(s): piano") });
  });

  it("removes a piece with its approach zones, or moves one", () => {
    const gone = applyChanges(scenario, "check_layout", { ...keep, remove_object_ids: ["dresser"] }, []);
    expect(gone.ok && gone.scenario.objects.map((o) => o.id)).toEqual(["bed", "desk"]);
    expect(gone.ok && gone.changes).toEqual(["Without Dresser"]);
    const moved = applyChanges(scenario, "check_layout",
      { ...keep, move: [{ object_id: "dresser", x_cm: 90, y_cm: 300, rotation_deg: 0 }] }, []);
    expect(moved.ok && moved.scenario.objects.find((o) => o.id === "dresser")).toMatchObject({ x_cm: 90, y_cm: 300 });
  });

  it("adds new furniture for the planner to place, reachable if asked", () => {
    const desk = { label: "Standing desk", kind: "desk", width_cm: 120, depth_cm: 60, approach_side: "bottom" };
    const r = applyChanges(scenario, "find_layouts", { ...keep, add_furniture: [desk] }, said("a 120 by 60 cm desk"));
    if (!r.ok) throw new Error(r.error);
    expect(r.scenario.objects.at(-1)).toMatchObject({ id: "new-standing-desk", to_place: true, confirmed: true });
    expect(r.scenario.requirements.required_destination_ids).toContain("new-standing-desk-approach");
    expect(r.changes).toEqual(["New Standing desk 120 × 60 cm, placed by the planner, reached from its bottom side"]);
    // check_layout needs a position for it
    expect(applyChanges(scenario, "check_layout", { ...keep, add_furniture: [desk] }, said("120 by 60")).ok).toBe(false);
  });
});

describe("tools and summaries", () => {
  it("offers strict tools limited to the room's real ids", () => {
    const [check, find] = assistantTools(scenario);
    expect(check.function.strict && find.function.strict).toBe(true);
    expect(JSON.stringify(check.function.parameters)).toContain('"enum":["bed","desk","dresser"]');
    expect(Object.keys((find.function.parameters as { properties: object }).properties)).toContain("optimization_profile");
  });

  it("describes placed new pieces and falls back to a planner-only answer", () => {
    const validation = { status: "pass", checks: [], routes: [], turning_zones: [], reachable_area: [], assumptions: [],
      warnings: [], grid_cm: 5, elapsed_ms: 1, widest_route_cm: 104 } satisfies ValidationResult;
    const result: OptimizationResult = {
      status: "solutions_found", message: "Found 1 verified alternative with a place for the new Shelf.", baseline: validation,
      search: { grid_spacing_cm: 20, time_limit_s: 5, elapsed_s: 0.2, combinations_considered: 9, candidates_tested: 4, exhaustive: false },
      warnings: [], alternatives: [{ id: "alternative-1", layout: { object_positions: [] }, validation,
        cost: { moved_objects: 0, displacement_cm: 0, route_length_cm: 120, total_score: 6 },
        moves: [{ object_id: "new-shelf", from_x_cm: 0, from_y_cm: 200, from_rotation_deg: 90, to_x_cm: 0, to_y_cm: 200,
          to_rotation_deg: 90, distance_cm: 0, placed: true }] }],
    };
    const s = { ...scenario, objects: [...scenario.objects, { ...scenario.objects[2], id: "new-shelf", label: "Shelf", to_place: true }] };
    const summary = summarizeRun("find_layouts", ["New Shelf 100 × 40 cm, placed by the planner"], s, result);
    expect(summary.options).toEqual([{ option: 1, moves: ["Shelf (new): placed at (0, 200), turned to 90°"],
      widest_route_cm: 104, route_length_cm: 120 }]);
    const run = { id: "c1", tool: "find_layouts", changes: ["New Shelf 100 × 40 cm, placed by the planner"],
      scenario: s, result, summary } satisfies AssistantRun;
    expect(templateAnswer([run])).toBe("Searched New Shelf 100 × 40 cm, placed by the planner: Found 1 verified " +
      "alternative with a place for the new Shelf. Option 1 keeps routes verified up to 104 cm wide.");
  });
});
