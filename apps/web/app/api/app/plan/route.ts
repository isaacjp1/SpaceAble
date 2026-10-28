import type OpenAI from "openai";
import { z } from "zod";
import { idList } from "@/lib/ai";
import { object, orNull } from "@/lib/assistant";
import { META, metaClient, rateLimited, readJson } from "@/lib/meta";
import { apiError, plannerJson } from "@/lib/planner";
import { type OptimizationResult, type RoomScenario, RoomScenarioSchema } from "@/lib/schema";
import { PROFILES, PROFILE_KEYS, planScenario, summarize } from "@/lib/simple";

const ids = z.array(z.string().max(64)).max(40);
const Body = z.strictObject({
  scenario: RoomScenarioSchema,
  profile: z.enum(PROFILE_KEYS).nullable().default(null), // a tapped profile wins over the description
  description: z.string().max(1000).default(""),
  reach: ids.default([]),
  keep: ids.default([]),
  remove: ids.default([]),
  start_door_id: z.string().max(64).nullable().default(null),
});
const Needs = z.strictObject({ profile: z.enum(PROFILE_KEYS).nullable(), reach: ids, keep: ids });

// Planner time limit 8 s, plus the final validations; at most two runs (see the door below).
export const maxDuration = 60;

/** Muse reads the person's own words into a profile and piece ids. It picks; it never measures. */
async function readNeeds(client: OpenAI, text: string, s: RoomScenario, signal: AbortSignal) {
  const pieces = s.objects.map((o) => o.id);
  const completion = await client.chat.completions.create({
    model: META.muse, reasoning_effort: "low", max_completion_tokens: 2000,
    messages: [
      { role: "system", content: "Read how a person gets around, and what they need in their room, from their own words. " +
        "Call record_needs once. profile: the closest of " +
        PROFILE_KEYS.map((k) => `${k} (${PROFILES[k].name})`).join(", ") + "; null if they don't say. " +
        "reach: pieces they say they need to get to. keep: pieces they say must stay where they are. " +
        "Use only the piece ids given, and leave a list empty when they say nothing about it." },
      { role: "user", content: JSON.stringify({ pieces: s.objects.map((o) => ({ id: o.id, label: o.label })), words: text }) },
    ],
    tools: [{ type: "function", function: { name: "record_needs", strict: true,
      description: "Record the person's mobility aid and the pieces they mentioned.",
      parameters: object({ profile: orNull({ type: "string", enum: PROFILE_KEYS }), reach: idList(pieces), keep: idList(pieces) }) } }],
  }, { signal });
  const call = completion.choices[0]?.message.tool_calls?.find((c) => c.type === "function");
  const needs = call ? Needs.safeParse(JSON.parse(call.function.arguments)) : null;
  if (!needs?.success) throw new Error("Muse didn't understand that.");
  return needs.data;
}

/** iPhone app: the person's choices on the checked draft → a verified rearrangement in plain words. */
export async function POST(req: Request) {
  const limited = rateLimited(req, "optimize", 20);
  if (limited) return limited;
  const body = await readJson(req, 512 * 1024);
  if (body instanceof Response) return body;
  const parsed = Body.safeParse(body);
  if (!parsed.success) return apiError(422, "VALIDATION_ERROR", parsed.error.issues[0].message);
  const { scenario: s, description, start_door_id } = parsed.data;
  let { profile, reach, keep } = parsed.data;
  const pieces = new Set(s.objects.map((o) => o.id));
  const unknown = [...reach, ...keep, ...parsed.data.remove].filter((i) => !pieces.has(i));
  if (start_door_id && !s.doors.some((d) => d.id === start_door_id)) unknown.push(start_door_id);
  if (unknown.length) return apiError(422, "VALIDATION_ERROR", `Unknown id(s): ${unknown.join(", ")}.`);

  const client = description.trim() ? metaClient() : null;
  if (client) {
    try {
      const needs = await readNeeds(client, description, s, req.signal);
      profile ??= needs.profile;
      reach = [...new Set([...reach, ...needs.reach])];
      keep = [...new Set([...keep, ...needs.keep])];
    } catch {
      if (!profile) return apiError(502, "UPSTREAM_UNAVAILABLE", "We couldn't read that description. Pick one of the options instead.", true);
    }
  }
  if (!profile) return apiError(400, "VALIDATION_ERROR", "Pick one of the options for how you get around.");

  const planned = planScenario(s, { profile, reach, keep, remove: parsed.data.remove, startDoorId: start_door_id });
  const optimize = (scenario: RoomScenario) => plannerJson<OptimizationResult>("/v1/planner/optimize",
    { scenario, options: { time_limit_s: 8 } }, 25_000, req.signal);
  try {
    let result = await optimize(planned);
    // A narrow door fails every layout, so plan the furniture with the door as it is and say so.
    const door = planned.doors.find((d) => d.id === planned.requirements.start_door_id);
    const narrow = result.baseline.checks.some((c) => c.id === "door-clearance" && c.status === "fail") && !!door?.clear_width_cm;
    if (narrow) {
      planned.requirements.door_min_clear_width_cm = door!.clear_width_cm;
      result = await optimize(planned);
    }
    return Response.json({ ...summarize(planned, result, profile, narrow), profile, scenario: planned });
  } catch (e) {
    return apiError(502, "UPSTREAM_UNAVAILABLE", e instanceof Error ? e.message : "The planner failed.", true);
  }
}
