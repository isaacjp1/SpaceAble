// ADA reference check: the room against the 2010 ADA Standards' dimensional rules that SpaceAble's
// 2D model can measure. A reference, never a compliance determination; the planner decides every
// check, on a copy of the room with the ADA values (the person's own requirements are untouched).
import type { Check, RoomScenario, Side, Status, ValidationResult } from "./schema";

// 1 in = 2.54 cm, written out so the values are exact.
const ROUTE = 91.44; // 36 in, 403.5.1
const DOOR = 81.28; // 32 in, 404.2.3
const TURN = 152.4; // 60 in circle, 304.3.1
const SHORT = 76.2; // 30 in } clear floor space, 305.3
const LONG = 121.92; // 48 in }
const FORWARD = new Set(["desk", "table"]); // used from the front, with knee space below
const BED_SIDE = "ada-"; // prefix of the zones added for both sides of each bed (806.2.3)

export const ADA_CHANGES = ["ADA 2010 reference: 36 in (91.44 cm) routes, 32 in (81.28 cm) door, 60 in " +
  "(152.4 cm) turning circle, 30 × 48 in (76.2 × 121.92 cm) clear floor spaces, both sides of each bed"];
export const ADA_NOTE = "A reference check against 5 dimensional rules of the 2010 ADA Standards, not a " +
  "compliance determination. The ADA applies to public places such as hotels, not most private homes, " +
  "and SpaceAble does not check the other rules listed.";
export const ADA_NOT_CHECKED = [
  ["404.2.4", "Space to open and pass through doors (door swing isn't modelled)"],
  ["302", "Floor surfaces"],
  ["303", "Thresholds and changes in floor level"],
  ["404.2.7, 404.2.9", "Door handles and opening force"],
  ["307", "Objects sticking out into the route"],
  ["308", "Reach ranges to shelves, rails and controls"],
  ["306, 902", "Knee and toe clearance, and work-surface height"],
  ["309", "Switches and other operable parts"],
  ["811", "Storage, closets and wardrobes"],
  ["603–610", "Toilet and bathing rooms"],
] as const;

/** A copy of the room with the ADA reference values and clear floor spaces. */
export function adaScenario(s: RoomScenario): RoomScenario {
  const next = structuredClone(s);
  Object.assign(next.requirements, { route_width_cm: ROUTE, door_min_clear_width_cm: DOOR, turning_diameter_cm: TURN });
  const kind = (id: string) => next.objects.find((o) => o.id === id)?.kind ?? "other";
  for (const d of next.destinations) {
    Object.assign(d, FORWARD.has(kind(d.object_id))
      ? { approach_width_cm: SHORT, approach_depth_cm: LONG } // forward: 30 in wide, 48 in deep
      : { approach_width_cm: LONG, approach_depth_cm: SHORT }); // side-on: 48 in along the piece
  }
  for (const bed of next.objects.filter((o) => o.kind === "bed" && !o.to_place)) {
    // Both long sides, in the bed's own (unrotated) frame, so they turn with it.
    const sides: Side[] = bed.height_cm >= bed.width_cm ? ["left", "right"] : ["top", "bottom"];
    if (next.destinations.length + sides.length > 20) break; // Limit: the planner's 20-zone cap
    for (const side of sides) {
      const id = `${BED_SIDE}${bed.id}-${side}`.slice(0, 64);
      next.destinations.push({ id, object_id: bed.id, side, approach_width_cm: LONG, approach_depth_cm: SHORT, required: true });
      next.requirements.required_destination_ids.push(id);
    }
  }
  return next;
}

export interface AdaRow {
  rule: string;
  title: string;
  requirement: string;
  status: Status;
  detail: string;
  note: string | null;
}

const worst = (xs: Status[]): Status => (xs.includes("fail") ? "fail"
  : xs.some((x) => x === "needs_input" || x === "unknown") ? "needs_input" : xs.length ? "pass" : "not_checked");

/** One row per ADA rule, from the planner's result for adaScenario(). */
export function adaReport(ada: RoomScenario, v: ValidationResult): AdaRow[] {
  const byId = (id: string) => v.checks.find((c) => c.id === id);
  const route = (dest: string) => v.checks.find((c) => c.id.startsWith("route-") && c.id.endsWith(`-to-${dest}`));
  const place = (dest: string) => {
    const d = ada.destinations.find((x) => x.id === dest)!;
    return `${ada.objects.find((o) => o.id === d.object_id)?.label ?? d.object_id} (${d.side} side)`;
  };
  const required = ada.requirements.required_destination_ids;
  const places = required.filter((i) => !i.startsWith(BED_SIDE));
  const bedSides = required.filter((i) => i.startsWith(BED_SIDE));
  const row = (ids: string[], checks: (id: string) => (Check | undefined)[], none: string) => {
    if (!ids.length) return { status: "not_checked" as Status, detail: none };
    const per = ids.map((id) => ({ id, cs: checks(id).filter((c): c is Check => c !== undefined) }));
    const bad = per.filter((p) => p.cs.some((c) => c.status !== "pass"));
    return {
      status: worst(per.flatMap((p) => p.cs.map((c) => c.status))),
      detail: bad.length
        ? bad.map((p) => `${place(p.id)}: ${p.cs.filter((c) => c.status !== "pass")
          .map((c) => c.message.replace(`Approach zone for ${p.id} `, "").replaceAll(p.id, place(p.id))).join(" ")}`).join(" ")
        : `Passes for ${ids.map(place).join(", ")}.`,
    };
  };
  const door = byId("door-clearance");
  const turning = byId("turning-space");
  return [
    { rule: "404.2.3", title: "Door clear width", requirement: "32 in (81.28 cm) minimum",
      status: door?.status ?? "not_checked", detail: door?.message ?? "No door in the plan.",
      note: "Measure the clear width with the door open 90°." },
    { rule: "403.5.1", title: "Route clear width", requirement: "36 in (91.44 cm) minimum",
      ...row(places, (id) => [route(id)], "No places to reach are marked."),
      note: "Stricter than the ADA: the 32 in allowance for stretches up to 24 in long isn't modelled." },
    { rule: "304.3", title: "Turning space", requirement: "60 in (152.4 cm) circle",
      status: turning?.status ?? "not_checked", detail: turning?.message ?? "",
      note: "Stricter than the ADA: the T-shaped turning space isn't modelled." },
    { rule: "305.3", title: "Clear floor space at each place you need to reach", requirement: "30 × 48 in (76.2 × 121.92 cm)",
      ...row(places, (id) => [byId(`approach-${id}`)], "No places to reach are marked."),
      note: "Approached from the front at desks and tables (30 in wide), side-on elsewhere (48 in along)." },
    { rule: "806.2.3", title: "Clear floor space on both sides of a bed", requirement: "30 × 48 in (76.2 × 121.92 cm), side-on, reachable",
      ...row(bedSides, (id) => [byId(`approach-${id}`), route(id)], "No bed in the plan."),
      note: "A guest-room rule for hotels and B&Bs; many homes won't need it." },
  ];
}

/** Counts that an answer may quote. */
export function adaCounts(rows: AdaRow[]) {
  const n = (s: Status) => rows.filter((r) => r.status === s).length;
  return { rules_checked: rows.length, passed: n("pass"), failed: n("fail"), needs_input: n("needs_input"),
    not_checked: n("not_checked"), other_rules_not_checked: ADA_NOT_CHECKED.length };
}
