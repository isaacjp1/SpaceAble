// Pure helpers for the Meta integrations, shared by API routes and UI.
// Model output is data to validate; it never decides pass/fail.
import { z } from "zod";
import { GOALS, type Alternative, type OptimizationResult, type RoomScenario, type Status, type ValidationResult } from "./schema";

// An empty enum is invalid JSON Schema, so an empty list allows no items at all.
export const idList = (ids: string[]) =>
  ids.length ? { type: "array", items: { type: "string", enum: ids } } : { type: "array", maxItems: 0 };

// ---- Muse: evidence-grounded explanation ------------------------------------------------

const STATUSES = ["pass", "fail", "not_checked", "needs_input", "unknown"] as const;
const OPTIMIZE_STATUSES = ["solutions_found", "no_solution_found_within_budget",
  "discretized_search_infeasible", "needs_input", "error"] as const;
const ResultEvidence = z.strictObject({
  status: z.enum(STATUSES),
  checks: z.array(z.strictObject({
    id: z.string().max(120),
    status: z.enum(STATUSES),
    required: z.boolean(),
    measured_cm: z.number().nullable(),
    required_cm: z.number().nullable(),
    message: z.string().max(400),
  })).max(40),
  widest_route_cm: z.number().nullable(), // widest route the planner verified; null = not measured
  warnings: z.array(z.string().max(400)).max(5),
});
export const EvidenceSchema = z.strictObject({
  requirements: z.strictObject({
    route_width_cm: z.number().nullable(),
    door_min_clear_width_cm: z.number().nullable(),
    turning_diameter_cm: z.number().nullable(),
    kept_in_place: z.array(z.string().max(80)).max(40), // labels the person locked
    fixed_furniture: z.array(z.string().max(80)).max(40), // labels marked as not movable
  }),
  before: ResultEvidence,
  after: ResultEvidence.nullable(),
  moves: z.array(z.strictObject({
    label: z.string().max(80), distance_cm: z.number(), turned_to_deg: z.number().nullable(),
  })).max(3),
  // Which goal the previewed option is best at: the optimizer offers one option per goal.
  option: z.strictObject({
    best_for: z.array(z.enum(GOALS)).max(2),
    moved_objects: z.number().int().min(0), route_length_cm: z.number(),
  }).nullable(),
  // The optimizer run behind what is on screen, including why it found nothing.
  search: z.strictObject({
    status: z.enum(OPTIMIZE_STATUSES), message: z.string().max(1000),
    options_found: z.number().int().min(0), layouts_checked: z.number().int().min(0), exhaustive: z.boolean(),
  }).nullable(),
  limitations: z.array(z.string().max(400)).max(10),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** Everything the planner reported about what is on screen: the current result and, when given,
 * the optimizer run and the option being previewed. */
export function buildEvidence(s: RoomScenario, before: ValidationResult, opt: OptimizationResult | null = null,
  alt: Alternative | null = null): Evidence {
  const result = (v: ValidationResult) => ({
    status: v.status,
    checks: v.checks.map(({ id, status, required, measured_cm, required_cm, message }) =>
      ({ id, status, required, measured_cm, required_cm, message })),
    widest_route_cm: v.widest_route_cm ?? null,
    warnings: v.warnings.slice(0, 5).map((w) => w.slice(0, 400)),
  });
  const { route_width_cm, door_min_clear_width_cm, turning_diameter_cm } = s.requirements;
  const label = (id: string) => s.objects.find((o) => o.id === id)?.label ?? id;
  return {
    requirements: {
      route_width_cm, door_min_clear_width_cm, turning_diameter_cm,
      kept_in_place: s.requirements.locked_object_ids.map(label),
      fixed_furniture: s.objects.filter((o) => !o.movable).map((o) => o.label),
    },
    before: result(before),
    after: alt && result(alt.validation),
    moves: (alt?.moves ?? []).map((m) => ({
      label: s.objects.find((o) => o.id === m.object_id)?.label ?? m.object_id,
      distance_cm: m.distance_cm,
      turned_to_deg: m.to_rotation_deg !== m.from_rotation_deg ? m.to_rotation_deg : null,
    })),
    option: alt ? {
      best_for: alt.best_for ?? [],
      moved_objects: alt.cost.moved_objects, route_length_cm: alt.cost.route_length_cm,
    } : null,
    search: opt && {
      status: opt.status, message: opt.message.slice(0, 1000),
      options_found: opt.alternatives.filter((a) => a.moves.length).length,
      layouts_checked: opt.search.candidates_tested, exhaustive: opt.search.exhaustive,
    },
    limitations: (alt?.validation ?? before).assumptions.slice(0, 10),
  };
}

export function explainMessages(e: Evidence) {
  return [
    {
      role: "system" as const,
      content:
        "You explain results from a deterministic floor-plan checker to someone who uses a mobility " +
        "device. Use only the evidence JSON. before is the current layout and after the proposed one " +
        "(null when nothing is proposed). widest_route_cm is the widest route the checker verified for " +
        "that layout; compare it with requirements.route_width_cm, the width the person needs. When it " +
        "is null it was not measured (for example because the layout fails): do not mention it. The " +
        "search offers one option with the fewest changes and one with the widest route; option.best_for " +
        "says which of those goals the proposed layout is (fewest_changes, widest_route or both). " +
        "requirements.kept_in_place lists furniture the person asked to keep where it is and " +
        "fixed_furniture lists pieces marked as fixed; the search never moves either. search " +
        "summarises the search for rearrangements, including why it found none; if it " +
        "found options but none is proposed, say they can preview one. Cover what the person most " +
        "needs to know: whether it passes, what blocks it or what moves, how much room the route " +
        "leaves, and what is still unknown. Use numbers exactly as they appear in the evidence, in cm, " +
        "without rounding, converting or quotation marks. Do not claim ADA or code compliance, " +
        "certification, safety, clinical benefit or guaranteed maneuverability. Write 3 to 6 short, " +
        "plain sentences.",
    },
    { role: "user" as const, content: JSON.stringify(e) },
  ];
}

type ResultEv = Evidence["before"];
const required = (r: ResultEv, status: Status) => r.checks.filter((c) => c.required && c.status === status);
const GOAL_NAMES = { fewest_changes: "fewest changes", widest_route: "widest route" } as const;

function summary(r: ResultEv): string[] {
  if (r.status === "pass") {
    return ["It passes the configured geometric checks.",
      ...required(r, "pass").filter((c) => c.id.startsWith("route-")).map((c) => c.message),
      ...(r.widest_route_cm !== null ? [`Routes stay verified up to ${r.widest_route_cm} cm wide.`] : [])];
  }
  if (r.status === "fail") return ["It does not pass.", ...required(r, "fail").map((c) => c.message)];
  return ["More information is needed.", ...required(r, "needs_input").map((c) => c.message)];
}

function searchSummary(e: Evidence): string[] {
  if (!e.search) return [];
  if (e.search.status !== "solutions_found") return [`Rearranging: ${e.search.message}`];
  const n = e.search.options_found;
  return n ? [`Rearranging found ${n} verified option${n > 1 ? "s" : ""}; preview one to see the change.`] : [];
}

/** Deterministic explanation built only from evidence strings and numbers. Always available. */
export function templateExplanation(e: Evidence): string {
  const option = e.option?.best_for.length
    ? ` (the ${e.option.best_for.map((g) => GOAL_NAMES[g]).join(" and ")} option)` : "";
  const { kept_in_place, fixed_furniture } = e.requirements;
  const kept = [...new Set([...kept_in_place, ...fixed_furniture])];
  const parts = e.after
    ? ["Before:", ...summary(e.before),
      `Proposed change${option}: ${e.moves.map((m) => `move ${m.label} ${m.distance_cm} cm` +
        (m.turned_to_deg !== null ? ` and turn it to ${m.turned_to_deg}°` : "")).join("; ")}.`,
      "After:", ...summary(e.after)]
    : ["Current layout:", ...summary(e.before), ...searchSummary(e)];
  if (kept.length && (e.after || e.search)) parts.push(`Not moved (kept in place or fixed): ${kept.join(", ")}.`);
  parts.push("This uses simplified 2D geometry and is not an accessibility certification or a safety " +
    "guarantee; check it in person.");
  return parts.join(" ");
}

const NUMBER = /\d+(?:\.\d+)?/g;
const CLAIM = /complian|\bcompl(y|ies)\b|certif|guarantee|wheelchair[- ]accessible|fully accessible|\bsafe(ly)?\b|\bsafety\b|\bmeets?\b[^.!?]*\bADA\b/i;
// The ADA may be named as the reference check ("passes 3 of the 5 ADA reference rules"); any other
// sentence about it counts as a claim.
const adaClaim = (sentence: string) => /\bADA\b/.test(sentence) && !/\breference\b/i.test(sentence);
const NEGATION = /\b(not|no|never|cannot|without)\b|n't\b/i;

/** Reject explanations with numbers absent from the evidence or unsupported positive claims. */
export function checkExplanation(text: string, e: unknown, alsoKnown: number[] = []):
  { ok: true } | { ok: false; reason: string } {
  const known = [...(JSON.stringify(e).match(NUMBER) ?? []).map(Number), ...alsoKnown];
  for (const n of (text.match(NUMBER) ?? []).map(Number)) {
    if (Number.isInteger(n) && n <= 3) continue; // counts such as "2 pieces" or "option 1"
    if (!known.some((k) => Math.abs(k - n) <= 0.51)) {
      return { ok: false, reason: `it mentions ${n}, which is not in the planner's evidence` };
    }
  }
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if ((CLAIM.test(sentence) || adaClaim(sentence)) && !NEGATION.test(sentence)) {
      return { ok: false, reason: `it makes a claim the planner cannot support ("${sentence.trim().slice(0, 80)}")` };
    }
  }
  return { ok: true };
}
