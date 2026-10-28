// The assistant route with Meta and the planner both mocked at the fetch layer.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as assistant } from "@/app/api/ai/assistant/route";
import type { AssistantEvent } from "@/lib/assistant";
import type { OptimizationResult, ValidationResult } from "@/lib/schema";

const scenario = JSON.parse(readFileSync(
  path.join(import.meta.dirname, "../../../shared/fixtures/canonical-bedroom.json"), "utf8"));
const keep = { route_width_cm: null, turning_diameter_cm: null, locked_object_ids: null,
  required_destination_ids: null, remove_object_ids: [], add_furniture: [] };

const validation = (status: ValidationResult["status"], widest: number | null = null): ValidationResult => ({
  status, checks: [{ id: "route-door-1-to-desk-approach", status, required: true, measured_cm: null, required_cm: 80,
    message: status === "pass" ? "Verified 80 cm route to desk-approach." : "No verified 80 cm route from door-1.",
    object_ids: [] }],
  routes: [], turning_zones: [], reachable_area: [], assumptions: [], warnings: [], grid_cm: 5, elapsed_ms: 1,
  widest_route_cm: widest,
});
const optimization: OptimizationResult = {
  status: "solutions_found", message: "Found 1 verified alternative.", baseline: validation("fail"), warnings: [],
  search: { grid_spacing_cm: 20, time_limit_s: 5, elapsed_s: 0.1, combinations_considered: 9, candidates_tested: 3, exhaustive: false },
  alternatives: [{ id: "alternative-1", layout: { object_positions: [] }, validation: validation("pass", 104),
    cost: { moved_objects: 1, displacement_cm: 35.4, route_length_cm: 100.8, total_score: 112 },
    moves: [{ object_id: "desk", from_x_cm: 115, from_y_cm: 35, from_rotation_deg: 0, to_x_cm: 120, to_y_cm: 0,
      to_rotation_deg: 0, distance_cm: 35.4 }] }],
};

type Reply = { tools?: { name: string; args: object }[]; text?: string };
const completion = ({ tools, text }: Reply) => Response.json({
  id: "c", object: "chat.completion", created: 0, model: "muse-spark-1.3",
  choices: [{ index: 0, finish_reason: tools ? "tool_calls" : "stop", message: { role: "assistant", content: text ?? null,
    tool_calls: tools?.map((t, i) => ({ id: `call_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) } }],
});

/** Muse replies in order; the planner answers analyze/optimize. Records every request body. */
function mock(replies: Reply[], planner: { analyze?: ValidationResult; optimize?: OptimizationResult } = {}) {
  const muse: Record<string, unknown>[] = [];
  const plannerCalls: { path: string; body: { scenario: { objects: { id: string; to_place: boolean }[] } } }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url instanceof Request ? url.url : url);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (href.includes("/chat/completions")) {
      muse.push(body);
      return completion(replies[muse.length - 1] ?? { text: "Done." });
    }
    plannerCalls.push({ path: new URL(href).pathname, body });
    return Response.json(href.endsWith("/optimize") ? planner.optimize : planner.analyze);
  }));
  return { muse, plannerCalls };
}

let ip = 0;
const ask = async (question: string, history: object[] = []) => {
  const res = await assistant(new Request("http://app/api/ai/assistant", {
    method: "POST", headers: { "x-forwarded-for": `10.0.0.${ip++}` }, // own rate-limit bucket per test
    body: JSON.stringify({ scenario, question, history }),
  }));
  const events = res.ok ? (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as AssistantEvent) : [];
  return { res, events, answer: events.find((e) => e.type === "answer") as Extract<AssistantEvent, { type: "answer" }> };
};

beforeEach(() => vi.stubEnv("MODEL_API_KEY", "test-key"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/ai/assistant", () => {
  it("returns META_NOT_CONFIGURED without a key", async () => {
    vi.stubEnv("MODEL_API_KEY", "");
    expect((await ask("Would a wider route fit?")).res.status).toBe(503);
  });

  it("chains planner rounds and streams progress, then a grounded answer", async () => {
    const { muse, plannerCalls } = mock([
      { tools: [{ name: "check_layout", args: keep }] },
      { tools: [{ name: "find_layouts", args: { ...keep, route_width_cm: 91.44, locked_object_ids: ["bed", "dresser"] } }] },
      { text: "Keeping the bed and dresser, moving the Desk 35.4 cm gives a 91.44 cm route, verified up to 104 cm wide. Load option 1 to see it." },
    ], { analyze: validation("fail"), optimize: optimization });
    const { events, answer } = await ask("Keep the dresser too. I need 36 inches to my desk.");
    expect(events.map((e) => e.type)).toEqual(["step", "tools", "run", "step", "tools", "run", "step", "answer"]);
    expect(answer).toMatchObject({ source: "muse", note: null });
    expect(plannerCalls.map((c) => c.path)).toEqual(["/v1/planner/analyze", "/v1/planner/optimize"]);
    expect(muse.every((m) => "tools" in m)).toBe(true);
    const run = events.find((e) => e.type === "run" && e.run.tool === "find_layouts");
    expect(run?.type === "run" && run.run.changes).toEqual(["Route width 91.44 cm", "Kept in place: Bed, Dresser"]);
  });

  it("sends an invented width back to Muse instead of running it", async () => {
    const { muse, plannerCalls } = mock([
      { tools: [{ name: "find_layouts", args: { ...keep, route_width_cm: 100 } }] },
      { text: "What route width do you need?" },
    ]);
    const { events, answer } = await ask("Could the route be wider?");
    expect(plannerCalls).toEqual([]);
    const tools = events.find((e) => e.type === "tools");
    expect(tools?.type === "tools" && tools.calls[0].error).toContain("Not stated by the person");
    expect(JSON.stringify(muse[1].messages)).toContain("Not stated by the person");
    expect(answer).toMatchObject({ source: "muse", text: "What route width do you need?",
      note: "No planner check was run for this answer." });
  });

  it("gives the planner a new piece to place", async () => {
    const shelf = { label: "Bookshelf", kind: "shelf", width_cm: 100, depth_cm: 40, approach_side: null };
    const { plannerCalls } = mock([{ tools: [{ name: "find_layouts", args: { ...keep, add_furniture: [shelf] } }] }],
      { optimize: optimization });
    await ask("Would a 100 by 40 cm bookshelf fit?");
    expect(plannerCalls[0].body.scenario.objects.at(-1)).toMatchObject({ id: "new-bookshelf", to_place: true });
  });

  it("replaces an answer quoting numbers the planner never produced, and keeps the runs", async () => {
    mock([{ tools: [{ name: "check_layout", args: keep }] }, { text: "Your route is 120 cm wide." }],
      { analyze: validation("pass", 99) });
    const { events, answer } = await ask("Does my room work?");
    expect(events.some((e) => e.type === "run")).toBe(true);
    expect(answer.source).toBe("template");
    expect(answer.note).toContain("120");
    expect(answer.text).toBe("Checked the room as it is: it passes, with routes verified up to 99 cm wide.");
  });

  it("lets a follow-up quote earlier results only if they were for this same room", async () => {
    const earlier = { question: "Find me a layout", answer: "Option 1 works.", results: [{ tool: "find_layouts",
      options: [{ option: 1, widest_route_cm: 163 }] }] };
    mock([{ text: "Option 1 keeps routes verified up to 163 cm wide." }]);
    expect((await ask("How wide was option 1?", [{ ...earlier, same_room: true }])).answer.source).toBe("muse");
    mock([{ text: "Option 1 keeps routes verified up to 163 cm wide." }]);
    expect((await ask("How wide was option 1?", [{ ...earlier, same_room: false }])).answer.source).toBe("template");
  });

  it("runs the ADA reference check on a copy of the room with the ADA values", async () => {
    const { plannerCalls } = mock([
      { tools: [{ name: "ada_reference_check", args: {} }] },
      { text: "On the ADA reference check, none of the 5 rules pass. This is not a compliance determination." },
    ], { analyze: validation("fail") });
    const { events, answer } = await ask("Does my room meet ADA?");
    expect(plannerCalls.map((c) => c.path)).toEqual(["/v1/planner/analyze"]);
    const sent = plannerCalls[0].body.scenario as unknown as { requirements: object; destinations: { id: string }[] };
    expect(sent.requirements).toMatchObject({ route_width_cm: 91.44, door_min_clear_width_cm: 81.28, turning_diameter_cm: 152.4 });
    expect(sent.destinations.map((d) => d.id)).toContain("ada-bed-right");
    const run = events.find((e) => e.type === "run");
    expect(run?.type === "run" && run.run.summary).toMatchObject({ tool: "ada_reference_check", rules_checked: 5 });
    expect(answer.source).toBe("muse");
  });

  it("stops offering tools after the last round so Muse has to answer", async () => {
    const again = { tools: [{ name: "check_layout", args: keep }] };
    const { muse } = mock([again, again, again, { text: "It does not pass yet." }], { analyze: validation("fail") });
    const { answer } = await ask("Keep checking my room.");
    expect(muse.map((m) => "tools" in m)).toEqual([true, true, true, false]);
    expect(answer.source).toBe("muse");
  });
});
