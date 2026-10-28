import type OpenAI from "openai";
import type {
  ChatCompletionMessageFunctionToolCall, ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { z } from "zod";
import { ADA_CHANGES, adaScenario } from "@/lib/ada";
import { checkExplanation } from "@/lib/ai";
import {
  type AssistantEvent, type AssistantRun, MAX_CALLS_PER_ROUND, MAX_HISTORY, MAX_ROUNDS, MAX_RUNS, type ToolName,
  type Turn, applyChanges, assistantMessages, assistantTools, groundingEvidence, statedNumbers, summarizeRun,
  templateAnswer,
} from "@/lib/assistant";
import { META, metaClient, metaError, notConfigured, rateLimited, readJson } from "@/lib/meta";
import { apiError, plannerJson } from "@/lib/planner";
import { RoomScenarioSchema, type OptimizationResult, type RoomScenario, type ValidationResult } from "@/lib/schema";

const TurnSchema = z.strictObject({
  question: z.string().max(1000),
  answer: z.string().max(4000).nullable(),
  same_room: z.boolean(), // computed on the room as it is now
  results: z.array(z.record(z.string(), z.unknown())).max(MAX_RUNS),
});
const Body = z.strictObject({
  scenario: RoomScenarioSchema,
  question: z.string().trim().min(3).max(1000),
  history: z.array(TurnSchema).max(MAX_HISTORY).default([]),
});
const TOOLS: string[] = ["check_layout", "find_layouts", "ada_reference_check"] satisfies ToolName[];
const DEADLINE_MS = 100_000; // after this Muse answers with whatever has run
const OPTIMIZE_LIMIT_S = 5;

// Muse Spark plans planner checks over up to MAX_ROUNDS rounds; the planner decides; the answer may
// quote only numbers from the planner, the room or the person. Nothing is applied to the room here.
// Progress streams as newline-delimited JSON (AssistantEvent).
// Hosting platforms read this; several Muse calls and planner searches need more than the default.
export const maxDuration = 120;

export async function POST(req: Request) {
  const limited = rateLimited(req, "assistant", 6); // one question can start several planner searches
  if (limited) return limited;
  const client = metaClient();
  if (!client) return notConfigured();
  const body = await readJson(req, 512 * 1024);
  if (body instanceof Response) return body;
  const parsed = Body.safeParse(body);
  if (!parsed.success) return apiError(422, "VALIDATION_ERROR", parsed.error.issues[0].message);
  const { scenario, question, history } = parsed.data;

  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const send = (e: AssistantEvent) => {
        try { controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`)); } catch { /* the browser left */ }
      };
      try {
        await converse(client, scenario, question, history, send, req.signal);
      } catch (e) {
        if (!req.signal.aborted) send({ type: "error", error: (await metaError(e).json()).error });
      } finally {
        try { controller.close(); } catch { /* already cancelled */ }
      }
    },
  }), { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

type Ran = { content: string; run: AssistantRun | null }; // content: what Muse is told

/** One planner run for a planned call; failures go back to Muse as data, not as an error. */
async function runTool(p: Planned, send: (e: AssistantEvent) => void, signal: AbortSignal): Promise<Ran> {
  if ("error" in p) return { content: JSON.stringify({ error: p.error }), run: null };
  try {
    const result = p.tool !== "find_layouts" // check_layout and the ADA reference check analyze
      ? await plannerJson<ValidationResult>("/v1/planner/analyze", { scenario: p.scenario }, 30_000, signal)
      : await plannerJson<OptimizationResult>("/v1/planner/optimize",
        { scenario: p.scenario, options: { time_limit_s: OPTIMIZE_LIMIT_S } }, 40_000, signal);
    const run: AssistantRun = { id: p.call.id, tool: p.tool, changes: p.changes, scenario: p.scenario, result,
      summary: summarizeRun(p.tool, p.changes, p.scenario, result) };
    send({ type: "run", run });
    return { content: JSON.stringify(run.summary), run };
  } catch (e) {
    if (signal.aborted) throw e;
    const message = e instanceof Error ? e.message : "The planner failed.";
    send({ type: "run_error", id: p.call.id, message });
    return { content: JSON.stringify({ error: message }), run: null };
  }
}

type Planned = { call: ChatCompletionMessageFunctionToolCall; tool: ToolName } &
  ({ scenario: RoomScenario; changes: string[] } | { error: string });

async function converse(client: OpenAI, s: RoomScenario, question: string, history: Turn[],
  send: (e: AssistantEvent) => void, signal: AbortSignal) {
  const said = statedNumbers([question, ...history.map((t) => t.question)]);
  const messages: ChatCompletionMessageParam[] = assistantMessages(s, question, history);
  const tools = assistantTools(s);
  const runs: AssistantRun[] = [];
  const deadline = Date.now() + DEADLINE_MS;
  let text = "";
  let model: string | null = null;

  for (let round = 1; ; round++) {
    // The last call offers no tools, so Muse has to answer from what has run.
    const last = round > MAX_ROUNDS || runs.length >= MAX_RUNS || Date.now() > deadline;
    send({ type: "step", round, kind: last ? "answer" : "think" });
    const completion = await client.chat.completions.create({
      model: META.muse, messages, ...(last ? {} : { tools }), reasoning_effort: "low", max_completion_tokens: 4000,
    }, { signal });
    model = completion.model;
    const choice = completion.choices[0];
    const calls = (choice?.message.tool_calls ?? [])
      .filter((c): c is ChatCompletionMessageFunctionToolCall => c.type === "function");
    if (last || !calls.length) {
      text = choice?.finish_reason === "length" ? "" : choice?.message.content?.trim() ?? "";
      break;
    }
    messages.push(choice.message);

    const space = Math.min(MAX_CALLS_PER_ROUND, MAX_RUNS - runs.length);
    const planned: Planned[] = calls.map((call, i) => {
      const tool = call.function.name as ToolName;
      if (i >= space) return { call, tool, error: "Too many checks at once; ask for fewer next round." };
      if (!TOOLS.includes(tool)) return { call, tool, error: `There is no tool called ${call.function.name}.` };
      if (tool === "ada_reference_check") return { call, tool, scenario: adaScenario(s), changes: ADA_CHANGES };
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); } catch { return { call, tool, error: "The arguments were not JSON." }; }
      const applied = applyChanges(s, tool, args, said);
      return applied.ok ? { call, tool, scenario: applied.scenario, changes: applied.changes } : { call, tool, error: applied.error };
    });
    send({ type: "tools", round, calls: planned.map((p) => ({ id: p.call.id, tool: p.tool,
      changes: "changes" in p ? p.changes : null, error: "error" in p ? p.error : null })) });

    // Limit: one planner call at a time. The planner is one Python process, and concurrent
    // searches thrash on its GIL (live: 3 at once each hit the 5 s limit; one alone took 0.7 s).
    // Run them in parallel once the planner has several worker processes.
    const done: Ran[] = [];
    for (const p of planned) done.push(await runTool(p, send, signal));
    runs.push(...done.flatMap((d) => (d.run ? [d.run] : [])));
    messages.push(...planned.map((p, i) => ({ role: "tool" as const, tool_call_id: p.call.id, content: done[i].content })));
  }

  const check = text ? checkExplanation(text, groundingEvidence(s, runs, history), said)
    : { ok: false as const, reason: "its reply was empty or cut off" };
  if (!check.ok) {
    send({ type: "answer", source: "template", model, text: templateAnswer(runs),
      note: `Muse's answer was discarded because ${check.reason}.` });
  } else {
    send({ type: "answer", source: "muse", model, text, note: runs.length ? null : "No planner check was run for this answer." });
  }
}
