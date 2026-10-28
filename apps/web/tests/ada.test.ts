import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { adaCounts, adaReport, adaScenario } from "@/lib/ada";
import { checkExplanation } from "@/lib/ai";
import { type Check, RoomScenarioSchema, type ValidationResult } from "@/lib/schema";

const scenario = RoomScenarioSchema.parse(JSON.parse(readFileSync(
  path.join(import.meta.dirname, "../../../shared/fixtures/canonical-bedroom.json"), "utf8")));

describe("the ADA copy of the room", () => {
  const ada = adaScenario(scenario);

  it("uses the 2010 ADA values and leaves the person's own requirements alone", () => {
    expect(ada.requirements).toMatchObject({ route_width_cm: 91.44, door_min_clear_width_cm: 81.28, turning_diameter_cm: 152.4 });
    expect(scenario.requirements).toMatchObject({ route_width_cm: 80, turning_diameter_cm: null });
  });

  it("gives desks a forward clear floor space and other pieces a side-on one, 30 × 48 in", () => {
    expect(ada.destinations.find((d) => d.id === "desk-approach")).toMatchObject({ approach_width_cm: 76.2, approach_depth_cm: 121.92 });
    expect(ada.destinations.find((d) => d.id === "bed-approach")).toMatchObject({ approach_width_cm: 121.92, approach_depth_cm: 76.2 });
  });

  it("adds both long sides of each bed as places to reach", () => {
    expect(ada.destinations.filter((d) => d.id.startsWith("ada-")).map((d) => [d.id, d.side]))
      .toEqual([["ada-bed-left", "left"], ["ada-bed-right", "right"]]);
    expect(ada.requirements.required_destination_ids).toEqual(["desk-approach", "ada-bed-left", "ada-bed-right"]);
  });
});

describe("the ADA report", () => {
  const ada = adaScenario(scenario);
  const c = (id: string, status: Check["status"], message = ""): Check =>
    ({ id, status, required: true, measured_cm: null, required_cm: null, message, object_ids: [] });
  const result: ValidationResult = {
    status: "fail", routes: [], turning_zones: [], reachable_area: [], assumptions: [], warnings: [], grid_cm: 5,
    elapsed_ms: 1, widest_route_cm: null, checks: [
      c("door-clearance", "pass", "Door door-1 clear width 90 cm ≥ 81.28 cm."),
      c("approach-desk-approach", "fail", "Approach zone for desk-approach overlaps dresser."),
      c("route-door-1-to-desk-approach", "fail", "No verified 91.44 cm route from door-1 to the desk-approach approach zone."),
      c("approach-ada-bed-left", "pass"), c("route-door-1-to-ada-bed-left", "pass"),
      c("approach-ada-bed-right", "fail", "Approach zone for ada-bed-right extends past a wall."),
      c("route-door-1-to-ada-bed-right", "fail", "No verified 91.44 cm route."),
      c("turning-space", "fail", "No 152.4 cm turning circle fits."),
    ],
  };
  const rows = adaReport(ada, result);

  it("gives one row per modelled rule from the planner's checks", () => {
    expect(rows.map((r) => [r.rule, r.status])).toEqual([
      ["404.2.3", "pass"], ["403.5.1", "fail"], ["304.3", "fail"], ["305.3", "fail"], ["806.2.3", "fail"]]);
    expect(adaCounts(rows)).toMatchObject({ rules_checked: 5, passed: 1, failed: 4, other_rules_not_checked: 10 });
  });

  it("names places by furniture and side, not by id", () => {
    expect(rows[3].detail).toBe("Desk (bottom side): overlaps dresser.");
    expect(rows[4].detail).toContain("Bed (right side): extends past a wall.");
    expect(rows[4].detail).not.toContain("ada-bed");
  });

  it("marks rules with nothing to check as not checked", () => {
    const empty = adaScenario({ ...scenario, objects: scenario.objects.filter((o) => o.kind !== "bed"),
      destinations: scenario.destinations.filter((d) => d.object_id !== "bed"),
      requirements: { ...scenario.requirements, locked_object_ids: [] } });
    expect(adaReport(empty, result).at(-1)).toMatchObject({ status: "not_checked", detail: "No bed in the plan." });
  });
});

describe("talking about the ADA", () => {
  const evidence = { rules: 5, passed: 1 };
  it("allows describing the reference check, never a compliance claim", () => {
    expect(checkExplanation("Your room passes 1 of the 5 ADA reference rules.", evidence)).toEqual({ ok: true });
    expect(checkExplanation("This is not a compliance determination.", evidence)).toEqual({ ok: true });
    expect(checkExplanation("Your room meets ADA.", evidence).ok).toBe(false);
    expect(checkExplanation("The bedroom follows the ADA.", evidence).ok).toBe(false);
    expect(checkExplanation("The door complies with the ADA reference rule.", evidence).ok).toBe(false);
  });
});
