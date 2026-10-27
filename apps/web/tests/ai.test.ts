import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Evidence, buildEvidence, checkExplanation, checkProposal, constraintSchema, templateExplanation,
} from "@/lib/ai";
import {
  type Alternative, type OptimizationResult, RoomScenarioSchema, type ValidationResult,
} from "@/lib/schema";

const scenario = RoomScenarioSchema.parse(JSON.parse(readFileSync(
  path.join(import.meta.dirname, "../../../shared/fixtures/canonical-bedroom.json"), "utf8")));

const proposal = (over: object = {}) => ({
  locked_object_ids: ["bed"], required_destination_ids: ["desk-approach"], route_width_cm: null,
  turning_diameter_cm: null, optimization_profile: "minimal_changes", clarifying_questions: [],
  unsupported_requests: [], ...over,
});

describe("constraint proposal", () => {
  it("builds enums from the scenario and avoids empty enums", () => {
    const schema = constraintSchema(scenario);
    expect(schema.properties.locked_object_ids).toEqual(
      { type: "array", items: { type: "string", enum: ["bed", "desk", "dresser"] } });
    const empty = constraintSchema({ ...scenario, destinations: [] });
    expect(empty.properties.required_destination_ids).toEqual({ type: "array", maxItems: 0 });
  });

  it("accepts a valid proposal", () => {
    const r = checkProposal(proposal({ route_width_cm: 90 }), scenario, "I need a 90 cm route to my desk");
    expect(r).toEqual({ ok: true, proposal: proposal({ route_width_cm: 90 }) });
  });

  it("rejects ids that do not exist", () => {
    const r = checkProposal(proposal({ locked_object_ids: ["bed", "piano"] }), scenario, "keep the piano");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("piano") });
  });

  it("rejects replies that do not match the schema", () => {
    expect(checkProposal({ ...proposal(), extra: 1 }, scenario, "x").ok).toBe(false);
    expect(checkProposal(proposal({ route_width_cm: -5 }), scenario, "-5 cm").ok).toBe(false);
  });

  it("keeps a missing width missing", () => {
    const r = checkProposal(proposal(), scenario, "make the route to my desk clearer");
    expect(r.ok && r.proposal.route_width_cm).toBeNull();
  });

  it("turns a width the text never stated into a question instead of a value", () => {
    const r = checkProposal(proposal({ route_width_cm: 100 }), scenario, "about one metre wide please");
    if (!r.ok) throw new Error(r.error);
    expect(r.proposal.route_width_cm).toBeNull();
    expect(r.proposal.clarifying_questions[0]).toContain("100 cm");
  });
});

const result = (status: ValidationResult["status"], checks: Partial<ValidationResult["checks"][number]>[]):
  ValidationResult => ({
  status, routes: [], turning_zones: [], reachable_area: [], warnings: [], grid_cm: 5, elapsed_ms: 7,
  assumptions: ["2D floor geometry only."], widest_route_cm: null,
  checks: checks.map((c) => ({ id: "x", status: "pass", required: true, measured_cm: null, required_cm: null,
    message: "", object_ids: [], ...c })),
});

const before = result("fail", [
  { id: "approach-desk-approach", status: "fail", message: "Approach zone for desk-approach overlaps dresser." },
  { id: "route-door-1-to-desk-approach", status: "fail", required_cm: 80,
    message: "No verified 80 cm route from door-1 to the desk-approach approach zone." },
]);
const after = {
  ...result("pass", [{ id: "route-door-1-to-desk-approach", measured_cm: 82, required_cm: 80,
    message: "Verified 80 cm route to desk-approach, 100.8 cm long. Closest wall or furniture: 41.0 cm." }]),
  widest_route_cm: 99,
};
const alt: Alternative = {
  id: "alternative-1", layout: { object_positions: [] }, validation: after,
  moves: [{ object_id: "desk", from_x_cm: 115, from_y_cm: 35, from_rotation_deg: 0, to_x_cm: 120, to_y_cm: 0,
    to_rotation_deg: 0, distance_cm: 35.4 }],
  cost: { moved_objects: 1, displacement_cm: 35.4, route_length_cm: 100.8, total_score: 112.1 },
};
const search = { grid_spacing_cm: 20, time_limit_s: 10, elapsed_s: 0.2, combinations_considered: 40,
  candidates_tested: 8, exhaustive: false };
const opt: OptimizationResult = { status: "solutions_found", message: "Found 1 verified alternative.",
  alternatives: [alt], baseline: before, search, warnings: [] };
const evidence: Evidence = buildEvidence(scenario, before, opt, alt);

describe("explanations", () => {
  it("template uses only evidence and passes its own grounding check", () => {
    const text = templateExplanation(evidence);
    expect(text).toContain("move Desk 35.4 cm");
    expect(text).toContain("Verified 80 cm route");
    expect(text).toContain("option 1 of 1, ranked by fewest changes");
    expect(text).toContain("Routes stay verified up to 99 cm wide.");
    expect(text).toContain("Not moved (kept in place or fixed): Bed.");
    expect(checkExplanation(text, evidence)).toEqual({ ok: true });
  });

  it("carries the widest route and ranking so Muse can quote them", () => {
    expect(evidence.after?.widest_route_cm).toBe(99);
    expect(evidence.option).toEqual({ rank: 1, of: 1, moved_objects: 1, route_length_cm: 100.8 });
    expect(evidence.requirements).toMatchObject({ kept_in_place: ["Bed"], fixed_furniture: ["Bed"] });
    expect(checkExplanation("After the move, the route stays verified up to 99 cm wide; you need 80 cm.",
      evidence)).toEqual({ ok: true });
  });

  it("explains why rearranging found nothing", () => {
    const none: OptimizationResult = { ...opt, status: "discretized_search_infeasible", alternatives: [],
      message: "Moving furniture cannot fix this under the current geometric model." };
    const e = buildEvidence(scenario, before, none);
    expect(e.search).toMatchObject({ status: "discretized_search_infeasible", options_found: 0, layouts_checked: 8 });
    const text = templateExplanation(e);
    expect(text).toContain("Rearranging: Moving furniture cannot fix this");
    expect(checkExplanation(text, e)).toEqual({ ok: true });
  });

  it("accepts evidence numbers, small rounding and negated disclaimers", () => {
    const text = "Moving the desk 35 cm clears an 80 cm route that is 100.8 cm long. " +
      "This is not a certification and does not guarantee safe movement.";
    expect(checkExplanation(text, evidence)).toEqual({ ok: true });
  });

  it("rejects numbers that are not in the evidence", () => {
    const r = checkExplanation("The new route is 120 cm wide.", evidence);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("120") });
  });

  it("rejects unsupported positive claims", () => {
    expect(checkExplanation("The room is now ADA compliant.", evidence).ok).toBe(false);
    expect(checkExplanation("Your route to the desk is safe.", evidence).ok).toBe(false);
  });
});

describe("echoed values", () => {
  it("treats Muse repeating the current width as 'keep current', not as a suggestion", () => {
    const r = checkProposal(proposal({ route_width_cm: 80 }), scenario, "make the route to my desk clearer");
    expect(r.ok && r.proposal.route_width_cm).toBeNull();
    expect(r.ok && r.proposal.clarifying_questions).toEqual([]);
  });
});
