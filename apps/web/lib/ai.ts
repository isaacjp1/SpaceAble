// Pure helpers for the Meta integrations, shared by API routes and UI.
// Model output is data to validate; it never decides pass/fail.
import { z } from "zod";
import type { Move, RoomScenario, Status, ValidationResult } from "./schema";

// ---- Muse: text -> constraint proposal -------------------------------------------------

export const PROFILES = ["minimal_changes", "max_clearance"] as const;

// An empty enum is invalid JSON Schema, so an empty list allows no items at all.
const idList = (ids: string[]) =>
  ids.length ? { type: "array", items: { type: "string", enum: ids } } : { type: "array", maxItems: 0 };

export function constraintSchema(s: RoomScenario) {
  const properties = {
    locked_object_ids: idList(s.objects.map((o) => o.id)),
    required_destination_ids: idList(s.destinations.map((d) => d.id)),
    route_width_cm: { type: ["number", "null"] },
    turning_diameter_cm: { type: ["number", "null"] },
    optimization_profile: { type: "string", enum: [...PROFILES] },
    clarifying_questions: { type: "array", items: { type: "string" } },
    unsupported_requests: { type: "array", items: { type: "string" } },
  };
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export function constraintMessages(s: RoomScenario, userText: string) {
  // No title or free-form notes: only what the model needs to map the request to IDs.
  const room = {
    room_cm: [s.room.width_cm, s.room.height_cm],
    objects: s.objects.map(({ id, label, kind, movable }) => ({ id, label, kind, movable })),
    destinations: s.destinations.map(({ id, object_id, side }) => ({ id, object_id, side })),
    current_requirements: {
      route_width_cm: s.requirements.route_width_cm,
      turning_diameter_cm: s.requirements.turning_diameter_cm,
      locked_object_ids: s.requirements.locked_object_ids,
      required_destination_ids: s.requirements.required_destination_ids,
      optimization_profile: s.requirements.optimization_profile,
    },
  };
  return [
    {
      role: "system" as const,
      content:
        "You turn a person's description of their room needs into constraint JSON for a floor-plan " +
        "checking tool. Start from current_requirements and change only what the request implies; " +
        "return complete lists. locked_object_ids: furniture the person wants left where it is. " +
        "required_destination_ids: places they need to reach. Use only the listed IDs. " +
        "Never invent measurements: route_width_cm and turning_diameter_cm must be null (meaning keep " +
        "the current value) unless the person states a new number; convert stated inches, feet or " +
        "metres to centimetres. Ask short " +
        "clarifying_questions for anything missing or ambiguous. List anything the tool cannot do " +
        "(structural changes, ramps, medical or equipment advice, code compliance) in " +
        "unsupported_requests. optimization_profile is minimal_changes unless they ask for the most " +
        "open space (max_clearance).",
    },
    { role: "user" as const, content: JSON.stringify({ room, request: userText }) },
  ];
}

const cm = z.number().positive().max(3000).nullable();
export const ProposalSchema = z.strictObject({
  locked_object_ids: z.array(z.string()).max(40),
  required_destination_ids: z.array(z.string()).max(20),
  route_width_cm: cm,
  turning_diameter_cm: cm,
  optimization_profile: z.enum(PROFILES),
  clarifying_questions: z.array(z.string().max(400)).max(8),
  unsupported_requests: z.array(z.string().max(400)).max(8),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** Re-validate Muse's reply: schema, known IDs only, and no measurements the text never gave. */
export function checkProposal(raw: unknown, s: RoomScenario, userText: string):
  { ok: true; proposal: Proposal } | { ok: false; error: string } {
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, error: `Muse's reply did not match the constraint schema (${i.path.join(".")}: ${i.message}).` };
  }
  const p = parsed.data;
  const objects = new Set(s.objects.map((o) => o.id));
  const dests = new Set(s.destinations.map((d) => d.id));
  const unknown = [
    ...p.locked_object_ids.filter((i) => !objects.has(i)),
    ...p.required_destination_ids.filter((i) => !dests.has(i)),
  ];
  if (unknown.length) {
    return { ok: false, error: `Muse referred to unknown id(s): ${unknown.join(", ")}. Nothing was applied.` };
  }
  for (const [key, what] of [["route_width_cm", "the route width"], ["turning_diameter_cm", "the turning circle"]] as const) {
    if (p[key] !== null && p[key] === s.requirements[key]) p[key] = null; // echoing the current value = keep it
    else if (p[key] !== null && !/\d/.test(userText)) {
      p.clarifying_questions.push(`Muse suggested ${p[key]} cm for ${what}, but your request has no ` +
        "measurement. Enter the value you need if you want to change it.");
      p[key] = null;
    }
  }
  return { ok: true, proposal: p };
}

// ---- Muse: evidence-grounded explanation ------------------------------------------------

const STATUSES = ["pass", "fail", "not_checked", "needs_input", "unknown"] as const;
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
});
export const EvidenceSchema = z.strictObject({
  requirements: z.strictObject({
    route_width_cm: z.number().nullable(),
    door_min_clear_width_cm: z.number().nullable(),
    turning_diameter_cm: z.number().nullable(),
  }),
  before: ResultEvidence,
  after: ResultEvidence.nullable(),
  moves: z.array(z.strictObject({
    label: z.string().max(80), distance_cm: z.number(), turned_to_deg: z.number().nullable(),
  })).max(3),
  limitations: z.array(z.string().max(400)).max(10),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export function buildEvidence(s: RoomScenario, before: ValidationResult, after: ValidationResult | null,
  moves: Move[]): Evidence {
  const result = (v: ValidationResult) => ({
    status: v.status,
    checks: v.checks.map(({ id, status, required, measured_cm, required_cm, message }) =>
      ({ id, status, required, measured_cm, required_cm, message })),
  });
  const { route_width_cm, door_min_clear_width_cm, turning_diameter_cm } = s.requirements;
  return {
    requirements: { route_width_cm, door_min_clear_width_cm, turning_diameter_cm },
    before: result(before),
    after: after && result(after),
    moves: moves.map((m) => ({
      label: s.objects.find((o) => o.id === m.object_id)?.label ?? m.object_id,
      distance_cm: m.distance_cm,
      turned_to_deg: m.to_rotation_deg !== m.from_rotation_deg ? m.to_rotation_deg : null,
    })),
    limitations: (after ?? before).assumptions.slice(0, 10),
  };
}

export function explainMessages(e: Evidence) {
  return [
    {
      role: "system" as const,
      content:
        "You explain results from a deterministic floor-plan checker to someone who uses a mobility " +
        "device. Use only the evidence JSON. Quote every number exactly as it appears in the evidence, " +
        "in cm, without rounding or converting. Do not claim ADA or code compliance, certification, " +
        "safety, clinical benefit or guaranteed maneuverability. If nothing passed, say what was " +
        "checked and what is still unknown. Write 3 to 5 short, plain sentences.",
    },
    { role: "user" as const, content: JSON.stringify(e) },
  ];
}

type ResultEv = Evidence["before"];
const required = (r: ResultEv, status: Status) => r.checks.filter((c) => c.required && c.status === status);

function summary(r: ResultEv): string[] {
  if (r.status === "pass") {
    return ["It passes the configured geometric checks.",
      ...required(r, "pass").filter((c) => c.id.startsWith("route-")).map((c) => c.message)];
  }
  if (r.status === "fail") return ["It does not pass.", ...required(r, "fail").map((c) => c.message)];
  return ["More information is needed.", ...required(r, "needs_input").map((c) => c.message)];
}

/** Deterministic explanation built only from evidence strings and numbers. Always available. */
export function templateExplanation(e: Evidence): string {
  const parts = e.after
    ? ["Before:", ...summary(e.before),
      `Proposed change: ${e.moves.map((m) => `move ${m.label} ${m.distance_cm} cm` +
        (m.turned_to_deg !== null ? ` and turn it to ${m.turned_to_deg}°` : "")).join("; ")}.`,
      "After:", ...summary(e.after)]
    : ["Current layout:", ...summary(e.before)];
  parts.push("This uses simplified 2D geometry and is not an accessibility certification or a safety " +
    "guarantee; check it in person.");
  return parts.join(" ");
}

const NUMBER = /\d+(?:\.\d+)?/g;
const CLAIM = /\bADA\b|complian|certif|guarantee|wheelchair[- ]accessible|fully accessible|\bsafe(ly)?\b|\bsafety\b/i;
const NEGATION = /\b(not|no|never|cannot|without)\b|n't\b/i;

/** Reject explanations with numbers absent from the evidence or unsupported positive claims. */
export function checkExplanation(text: string, e: Evidence): { ok: true } | { ok: false; reason: string } {
  const known = (JSON.stringify(e).match(NUMBER) ?? []).map(Number);
  for (const n of (text.match(NUMBER) ?? []).map(Number)) {
    if (Number.isInteger(n) && n <= 3) continue; // counts such as "2 pieces" or "option 1"
    if (!known.some((k) => Math.abs(k - n) <= 0.51)) {
      return { ok: false, reason: `it mentions ${n}, which is not in the planner's evidence` };
    }
  }
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (CLAIM.test(sentence) && !NEGATION.test(sentence)) {
      return { ok: false, reason: `it makes a claim the planner cannot support ("${sentence.trim().slice(0, 80)}")` };
    }
  }
  return { ok: true };
}
