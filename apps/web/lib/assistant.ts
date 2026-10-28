// Muse Spark assistant: Muse picks planner checks, the planner decides, and every number in the
// answer is checked against the planner's results. Pure helpers shared by the route and the UI.
import { z } from "zod";
import { PROFILES, buildEvidence, idList } from "./ai";
import { ADA_CHANGES, ADA_NOTE, ADA_NOT_CHECKED, adaCounts, adaReport, adaScenario } from "./ada";
import { describeMove } from "./geometry-ui";
import {
  KINDS, RoomScenarioSchema, type OptimizationResult, type RoomScenario, type ValidationResult,
} from "./schema";

export const MAX_ROUNDS = 3; // tool rounds before Muse must answer
export const MAX_CALLS_PER_ROUND = 4;
export const MAX_RUNS = 8; // planner runs per question
export const MAX_HISTORY = 4; // earlier turns sent back for follow-up questions
const NEW_PIECE_APPROACH = { approach_width_cm: 80, approach_depth_cm: 90 }; // as "Add approach zone"
const SIDES = ["top", "right", "bottom", "left"] as const;

export type ToolName = "check_layout" | "find_layouts" | "ada_reference_check";
export type RunSummary = Record<string, unknown>;
export interface AssistantRun {
  id: string;
  tool: ToolName;
  changes: string[]; // readable list, empty = the room as it is
  scenario: RoomScenario; // the what-if room the planner ran on
  result: ValidationResult | OptimizationResult;
  summary: RunSummary; // what Muse saw; sent back with follow-up questions
}
/** One earlier question, sent back so follow-ups have context. */
export interface Turn { question: string; answer: string | null; same_room: boolean; results: RunSummary[] }

/** Streamed to the browser as newline-delimited JSON. */
export type AssistantEvent =
  | { type: "step"; round: number; kind: "think" | "answer" }
  | { type: "tools"; round: number; calls: { id: string; tool: ToolName; changes: string[] | null; error: string | null }[] }
  | { type: "run"; run: AssistantRun }
  | { type: "run_error"; id: string; message: string }
  | { type: "answer"; source: "muse" | "template"; model: string | null; text: string; note: string | null }
  | { type: "error"; error: { code: string; message: string; retryable: boolean } };

// ---- tools -------------------------------------------------------------------------------

// `type: [t, "null"]`, not anyOf: live, Muse sent strings for anyOf arrays and Meta's strict mode
// didn't stop it.
const orNull = ({ type, enum: values, ...rest }: { type: string; enum?: readonly unknown[]; [k: string]: unknown }) =>
  ({ type: [type, "null"], ...(values ? { enum: [...values, null] } : {}), ...rest });
const object = (properties: Record<string, object>): Record<string, unknown> =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export function assistantTools(s: RoomScenario) {
  const pieces = s.objects.filter((o) => !o.to_place).map((o) => o.id);
  const where = {
    x_cm: { type: "number" }, y_cm: { type: "number" }, rotation_deg: { type: "integer", enum: [0, 90, 180, 270] },
  };
  const changes = (placed: boolean) => ({
    use_ada_values: { type: "boolean" }, // start from the ADA reference copy of the room
    route_width_cm: { type: ["number", "null"] },
    turning_diameter_cm: { type: ["number", "null"] },
    locked_object_ids: orNull(idList(pieces)),
    required_destination_ids: orNull(idList(s.destinations.map((d) => d.id))),
    remove_object_ids: idList(pieces),
    add_furniture: {
      type: "array", items: object({
        label: { type: "string" }, kind: { type: "string", enum: [...KINDS] },
        width_cm: { type: "number" }, depth_cm: { type: "number" },
        approach_side: orNull({ type: "string", enum: [...SIDES] }),
        ...(placed ? where : {}),
      }),
    },
  });
  const tool = (name: ToolName, description: string, parameters: Record<string, unknown>) =>
    ({ type: "function" as const, function: { name, description, parameters, strict: true } });
  return [
    tool("check_layout", "Check the room as it is, or with the changes given, against the person's " +
      "requirements. Returns the planner's checks and the widest verified route. New furniture and moves " +
      "need a position: the top-left corner in cm, rotation clockwise. null keeps the current value.",
    object({
      ...changes(true),
      move: pieces.length ? { type: "array", items: object({ object_id: { type: "string", enum: pieces }, ...where }) }
        : { type: "array", maxItems: 0 },
    })),
    tool("find_layouts", "Search for verified rearrangements of the room with the changes given. The " +
      "planner places any new furniture itself. Returns up to 3 options with their moves and widest " +
      "route. null keeps the current value.",
    object({ ...changes(false), optimization_profile: orNull({ type: "string", enum: [...PROFILES] }) })),
    tool("ada_reference_check", "Compare the room as it is with the 2010 ADA Standards' dimensional rules " +
      "SpaceAble can measure: 36 in routes, 32 in door, 60 in turning circle, 30 × 48 in clear floor " +
      "spaces, and both sides of each bed. A reference check, not a compliance determination. No arguments.",
    object({})),
  ];
}

const cm = z.number().positive().max(3000);
const coord = z.number().min(0).max(3000);
const rotation = z.literal([0, 90, 180, 270]);
// For an optional choice, "" or the string "null" means "keep current", like null (live, Muse sent
// "null" as a string).
const blankIsNull = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" || v === "null" ? null : v), schema);
const Changes = z.strictObject({
  route_width_cm: cm.nullable(),
  turning_diameter_cm: cm.nullable(),
  locked_object_ids: z.array(z.string()).max(40).nullable(),
  required_destination_ids: z.array(z.string()).max(20).nullable(),
  remove_object_ids: z.array(z.string()).max(40),
  use_ada_values: z.boolean().optional(),
  add_furniture: z.array(z.strictObject({
    label: z.string().trim().min(1).max(40), kind: z.enum(KINDS), width_cm: cm, depth_cm: cm,
    approach_side: blankIsNull(z.enum(SIDES).nullable()),
    x_cm: coord.optional(), y_cm: coord.optional(), rotation_deg: rotation.optional(),
  })).max(3),
  move: z.array(z.strictObject({ object_id: z.string(), x_cm: coord, y_cm: coord, rotation_deg: rotation }))
    .max(10).optional(),
  optimization_profile: blankIsNull(z.enum(PROFILES).nullable()).optional(),
});

// ---- the person's own numbers ------------------------------------------------------------

const UNITS: [RegExp, number][] = [ // a unit right after the number converts it to cm
  [/^(mm|millimet(re|er)s?)\b/, 0.1], [/^(m|met(re|er)s?)\b/, 100],
  [/^(in\b|inch(es)?\b|")/, 2.54], [/^(ft\b|feet\b|foot\b|')/, 30.48],
];
/** Every number the person wrote, plus its centimetre value when a unit follows it. A bare number
 * counts only as itself, so "option 2" never makes 200 cm a stated width. */
export function statedNumbers(texts: string[]): number[] {
  return texts.flatMap((t) => [...t.matchAll(/(\d+(?:\.\d+)?)\s*([a-z"']*)/gi)].flatMap(([, num, unit]) => {
    const n = Number(num);
    const f = UNITS.find(([re]) => re.test(unit.toLowerCase()))?.[1];
    return f ? [n, Math.round(n * f * 100) / 100] : [n];
  }));
}
const isStated = (v: number, said: number[]) => said.some((k) => Math.abs(k - v) <= 0.5);

// ---- applying a tool call ----------------------------------------------------------------

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "piece";

/** The what-if room for one tool call, or an error Muse can act on. Sizes and widths must come
 * from the person's words (`said`); positions need not, because the planner checks them. With
 * use_ada_values the changes apply to the ADA reference copy of the room instead. */
export function applyChanges(room: RoomScenario, tool: ToolName, raw: unknown, said: number[]):
  { ok: true; scenario: RoomScenario; changes: string[] } | { ok: false; error: string } {
  const parsed = Changes.safeParse(raw, { reportInput: true });
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, error: `Invalid arguments (${i.path.join(".")}: ${i.message}; got ${JSON.stringify(i.input)}).` };
  }
  const c = parsed.data;
  const s = c.use_ada_values ? adaScenario(room) : room;
  const ids = new Set(s.objects.filter((o) => !o.to_place).map((o) => o.id));
  const dests = new Set(s.destinations.map((d) => d.id));
  const unknown = [...(c.locked_object_ids ?? []), ...c.remove_object_ids, ...(c.move ?? []).map((m) => m.object_id)]
    .filter((i) => !ids.has(i)).concat((c.required_destination_ids ?? []).filter((i) => !dests.has(i)));
  if (unknown.length) return { ok: false, error: `Unknown id(s): ${unknown.join(", ")}. Use only the ids in the room.` };
  const unstated = [
    ...(["route_width_cm", "turning_diameter_cm"] as const)
      .filter((k) => c[k] !== null && c[k] !== s.requirements[k] && !isStated(c[k]!, said)).map((k) => `${k} ${c[k]}`),
    ...c.add_furniture.flatMap((p) => [p.width_cm, p.depth_cm].filter((v) => !isStated(v, said))
      .map((v) => `${p.label} size ${v}`)),
  ];
  if (unstated.length) {
    return { ok: false, error: `Not stated by the person: ${unstated.join(", ")}. Ask them for the measurement; never guess.` };
  }
  if (tool === "check_layout" && c.add_furniture.some((p) => p.x_cm === undefined || p.y_cm === undefined)) {
    return { ok: false, error: "New furniture in check_layout needs x_cm and y_cm; use find_layouts to let the planner place it." };
  }

  const label = (id: string) => s.objects.find((o) => o.id === id)?.label ?? id;
  const next = structuredClone(s);
  const req = next.requirements;
  const changes: string[] = c.use_ada_values ? [...ADA_CHANGES] : [];
  if (c.remove_object_ids.length) { // first, so later lists can't point at a removed piece
    const gone = new Set(c.remove_object_ids);
    const goneDests = new Set(next.destinations.filter((d) => gone.has(d.object_id)).map((d) => d.id));
    next.objects = next.objects.filter((o) => !gone.has(o.id));
    next.destinations = next.destinations.filter((d) => !goneDests.has(d.id));
    req.locked_object_ids = req.locked_object_ids.filter((i) => !gone.has(i));
    req.required_destination_ids = req.required_destination_ids.filter((i) => !goneDests.has(i));
    changes.push(`Without ${c.remove_object_ids.map(label).join(", ")}`);
  }
  if (c.route_width_cm !== null && c.route_width_cm !== s.requirements.route_width_cm) {
    req.route_width_cm = c.route_width_cm;
    changes.push(`Route width ${c.route_width_cm} cm`);
  }
  if (c.turning_diameter_cm !== null && c.turning_diameter_cm !== s.requirements.turning_diameter_cm) {
    req.turning_diameter_cm = c.turning_diameter_cm;
    changes.push(`Turning circle ${c.turning_diameter_cm} cm`);
  }
  const locked = c.locked_object_ids?.filter((i) => next.objects.some((o) => o.id === i));
  if (locked && !sameSet(locked, req.locked_object_ids)) {
    req.locked_object_ids = locked;
    changes.push(locked.length ? `Kept in place: ${locked.map(label).join(", ")}` : "Nothing kept in place");
  }
  const reach = c.required_destination_ids?.filter((i) => next.destinations.some((d) => d.id === i));
  if (reach && !sameSet(reach, req.required_destination_ids)) {
    req.required_destination_ids = reach;
    for (const d of next.destinations) d.required = reach.includes(d.id);
    const place = (i: string) => { const d = next.destinations.find((x) => x.id === i)!; return `${label(d.object_id)} (${d.side})`; };
    changes.push(`Must reach: ${reach.map(place).join(", ") || "nothing"}`);
  }
  for (const m of tool === "check_layout" ? c.move ?? [] : []) {
    const o = next.objects.find((x) => x.id === m.object_id);
    if (!o) continue; // removed in the same call
    const turned = m.rotation_deg !== o.rotation_deg ? `, turned to ${m.rotation_deg}°` : "";
    Object.assign(o, { x_cm: m.x_cm, y_cm: m.y_cm, rotation_deg: m.rotation_deg });
    changes.push(`${o.label} moved to (${m.x_cm}, ${m.y_cm})${turned}`);
  }
  for (const p of c.add_furniture) {
    let id = `new-${slug(p.label)}`;
    for (let n = 2; next.objects.some((o) => o.id === id); n++) id = `new-${slug(p.label)}-${n}`;
    const placed = tool === "check_layout";
    next.objects.push({
      id, label: p.label, kind: p.kind, x_cm: p.x_cm ?? 0, y_cm: p.y_cm ?? 0, width_cm: p.width_cm,
      height_cm: p.depth_cm, rotation_deg: p.rotation_deg ?? 0, movable: true,
      confirmed: true, // the sizes came from the person's own words (checked above)
      label_source: "user-provided", to_place: !placed,
    });
    if (p.approach_side) {
      next.destinations.push({ id: `${id}-approach`, object_id: id, side: p.approach_side, ...NEW_PIECE_APPROACH, required: true });
      req.required_destination_ids.push(`${id}-approach`);
    }
    changes.push(`New ${p.label} ${p.width_cm} × ${p.depth_cm} cm${placed ? ` at (${p.x_cm}, ${p.y_cm})` : ", placed by the planner"}` +
      (p.approach_side ? `, reached from its ${p.approach_side} side` : ""));
  }
  if (tool === "find_layouts" && c.optimization_profile && c.optimization_profile !== req.optimization_profile) {
    req.optimization_profile = c.optimization_profile;
    changes.push(c.optimization_profile === "max_clearance" ? "Ranked by widest route" : "Ranked by fewest changes");
  }
  const valid = RoomScenarioSchema.safeParse(next);
  return valid.success ? { ok: true, scenario: valid.data, changes }
    : { ok: false, error: `That what-if is not a valid room: ${valid.error.issues[0].message}` };
}

// ---- what Muse sees --------------------------------------------------------------------------

/** A compact record of one planner run, for Muse and for follow-up questions. */
export function summarizeRun(tool: ToolName, changes: string[], s: RoomScenario,
  result: ValidationResult | OptimizationResult): RunSummary {
  if (tool === "ada_reference_check") { // s is the ADA copy of the room
    const rows = adaReport(s, result as ValidationResult);
    return { tool, note: ADA_NOTE, ...adaCounts(rows),
      rules: rows.map(({ rule, title, requirement, status, detail }) => ({ rule, title, requirement, status, detail })),
      other_rules_not_checked_list: ADA_NOT_CHECKED.map(([rule, what]) => `${rule}: ${what}`) };
  }
  if (tool === "check_layout") {
    const v = result as ValidationResult;
    const { before } = buildEvidence(s, v);
    return { tool, changes, status: v.status, widest_route_cm: v.widest_route_cm, checks: before.checks, warnings: before.warnings };
  }
  const o = result as OptimizationResult;
  const piece = (id: string) => s.objects.find((x) => x.id === id) ?? { label: id, width_cm: 1, height_cm: 1 };
  return {
    tool, changes, search: { status: o.status, message: o.message, layouts_checked: o.search.candidates_tested },
    room_before_moves: o.baseline.status,
    options: o.alternatives.filter((a) => a.moves.length).map((a, i) => ({
      option: i + 1, moves: a.moves.map((m) => describeMove(m, piece(m.object_id))),
      widest_route_cm: a.validation.widest_route_cm, route_length_cm: a.cost.route_length_cm,
    })),
  };
}

export function roomSummary(s: RoomScenario) {
  const req = s.requirements;
  return {
    size_cm: [s.room.width_cm, s.room.height_cm],
    doors: s.doors.map(({ id, wall, offset_cm, clear_width_cm }) => ({ id, wall, offset_cm, clear_width_cm })),
    furniture: s.objects.filter((o) => !o.to_place).map((o) => ({
      id: o.id, label: o.label, kind: o.kind, x_cm: o.x_cm, y_cm: o.y_cm, width_cm: o.width_cm,
      depth_cm: o.height_cm, rotation_deg: o.rotation_deg, fixed: !o.movable, kept_in_place: req.locked_object_ids.includes(o.id),
    })),
    places_to_reach: s.destinations.map((d) => ({ id: d.id, object_id: d.object_id, side: d.side,
      required: req.required_destination_ids.includes(d.id) })),
    requirements: { route_width_cm: req.route_width_cm, door_min_clear_width_cm: req.door_min_clear_width_cm,
      turning_diameter_cm: req.turning_diameter_cm, optimization_profile: req.optimization_profile },
  };
}

export function assistantMessages(s: RoomScenario, question: string, history: Turn[]) {
  const earlier = history.map((t) => ({ question: t.question, answer: t.answer, results: t.results,
    ...(t.same_room ? {} : { older_room: true }) }));
  return [
    {
      role: "system" as const,
      content:
        "You are SpaceAble's assistant for someone who uses a wheelchair or another mobility device. A " +
        "geometry planner decides whether a layout works; you never do. For any question about this " +
        "room's layout, call the tools: check_layout checks the room with the changes you describe, and " +
        "find_layouts searches for verified rearrangements. Each call starts from the current room. You " +
        `may call several at once, and you get up to ${MAX_ROUNDS} rounds, so you can follow up on results ` +
        "(for example, if a check fails, search for a rearrangement before answering). Never make up a " +
        "measurement: use a route width, turning circle or furniture size only if the person stated " +
        "it, now or earlier; otherwise ask them. The room's requirements already set the route width " +
        "and turning circle: keep them (null) unless the person states new ones. Convert stated inches, " +
        "feet or metres to centimetres yourself (1 inch = 2.54 cm). When something else is ambiguous, " +
        "such as which side of a piece is its front, try the likely options in parallel rather than " +
        "asking. For new furniture use the person's sizes; in check_layout also pick a " +
        "position inside the room, in find_layouts the planner places it. 'earlier' holds this " +
        "conversation's previous questions with the planner results they used; results marked " +
        "older_room were computed before the room changed, so check again before relying on them. " +
        "Answer in 2 to 5 short, plain sentences: no markdown, no lists, furniture by its label and " +
        "never by id. Use only numbers from the tool results, the room or the person's words, exactly " +
        "as given, in cm. Report what the planner did without guessing why it moved a piece. Say which " +
        "what-if they can load to see it. For questions about the ADA, run ada_reference_check and " +
        "say how many of its rules pass and which fail; call it the ADA reference check, say it is not " +
        "a compliance determination, and that SpaceAble doesn't check the other ADA rules. To look for " +
        "a rearrangement that passes the ADA reference rules, call find_layouts with use_ada_values " +
        "true; otherwise use_ada_values is false and searches use the person's own requirements, so " +
        "never present such a result as fixing an ADA reference failure. Never say a " +
        "room meets or complies with the ADA. Decline other building-code, medical or equipment " +
        "questions in one sentence. Never claim compliance, certification, safety or guaranteed access.",
    },
    { role: "user" as const, content: JSON.stringify({ room: roomSummary(s), earlier, question }) },
  ];
}

/** What an answer may quote: the room, this question's planner runs and same-room earlier runs. */
export const groundingEvidence = (s: RoomScenario, runs: AssistantRun[], history: Turn[]) =>
  ({ room: roomSummary(s), runs: runs.map((r) => r.summary), earlier: history.filter((t) => t.same_room).map((t) => t.results) });

/** Deterministic answer from the planner runs alone, used when Muse's answer can't be shown. */
export function templateAnswer(runs: AssistantRun[]): string {
  if (!runs.length) return "No planner check was run, so there is nothing verified to report yet.";
  return runs.map((r) => {
    const what = r.changes.length ? r.changes.join("; ") : "the room as it is";
    if (r.tool === "ada_reference_check") {
      const rows = adaReport(r.scenario, r.result as ValidationResult);
      return `ADA reference check (not a compliance determination): ${adaCounts(rows).passed} of ${rows.length} ` +
        `rules pass. ${rows.map((x) => `${x.rule} ${x.title}: ${x.status.replace("_", " ")}`).join("; ")}.`;
    }
    if (r.tool === "check_layout") {
      const v = r.result as ValidationResult;
      const verdict = v.status === "pass" ? "passes" : v.status === "fail" ? "does not pass" : "needs more information";
      return `Checked ${what}: it ${verdict}${v.widest_route_cm !== null ? `, with routes verified up to ${v.widest_route_cm} cm wide` : ""}.`;
    }
    const o = r.result as OptimizationResult;
    const best = o.alternatives.find((a) => a.moves.length)?.validation.widest_route_cm;
    return `Searched ${what}: ${o.message}${best ? ` Option 1 keeps routes verified up to ${best} cm wide.` : ""}`;
  }).join(" ");
}
