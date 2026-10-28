"use client";

import { useRef, useState } from "react";
import { adaCounts, adaReport } from "@/lib/ada";
import { type AssistantEvent, type AssistantRun, MAX_HISTORY, type Turn } from "@/lib/assistant";
import type { ApiError, OptimizationResult, RoomScenario, ValidationResult } from "@/lib/schema";
import { MicButton } from "./MicButton";
import { Section } from "./Panels";
import { StatusBadge } from "./ValidationPanel";

const button =
  "rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50";

type Step = { key: string; label: string; state: "active" | "done" | "failed"; detail?: string };
type Answer = Extract<AssistantEvent, { type: "answer" }>;
type Exchange = {
  question: string;
  room: string; // the room it was asked about, to tell follow-ups whether results still apply
  steps: Step[];
  runs: AssistantRun[];
  answer: Answer | null;
  error: string | null;
};

const what = (changes: string[] | null) => (changes?.length ? changes.join("; ") : "the room as it is");

const VERB: Record<AssistantRun["tool"], [string, string]> = { // [in progress, done]
  check_layout: ["Checking", "Checked"], find_layouts: ["Searching", "Searched"],
  ada_reference_check: ["Running", "Ran"],
};

export function outcome(run: AssistantRun): string {
  if (run.tool === "ada_reference_check") {
    const rows = adaReport(run.scenario, run.result as ValidationResult);
    return `${adaCounts(rows).passed} of ${rows.length} ADA reference rules pass (not a compliance determination).`;
  }
  if (run.tool === "check_layout") {
    const v = run.result as ValidationResult;
    const verdict = v.status === "pass" ? "Passes" : v.status === "fail" ? "Does not pass" : "Needs more information";
    return `${verdict}${v.widest_route_cm !== null ? `; routes verified up to ${v.widest_route_cm} cm wide` : ""}.`;
  }
  const o = run.result as OptimizationResult;
  const best = o.alternatives.find((a) => a.moves.length)?.validation.widest_route_cm;
  return `${o.message}${best ? ` Option 1: routes verified up to ${best} cm wide.` : ""}`;
}

/** Fold one streamed event into the exchange: the step list drives the progress bar. */
function fold(t: Exchange, e: AssistantEvent): Exchange {
  const settle = (steps: Step[]) => steps.map((s) => (s.state === "active" && s.key.startsWith("muse-") ? { ...s, state: "done" as const } : s));
  switch (e.type) {
    case "step":
      return { ...t, steps: [...settle(t.steps), { key: `muse-${e.round}`, state: "active",
        label: e.kind === "answer" ? "Muse is writing the answer" : e.round === 1 ? "Muse is reading your question"
          : `Muse is looking at the results (round ${e.round})` }] };
    case "tools":
      return { ...t, steps: [...settle(t.steps), ...e.calls.map((c): Step => ({
        key: c.id, state: c.error ? "failed" : "active", detail: c.error ?? undefined,
        label: `${VERB[c.tool]?.[0] ?? "Running"}: ${c.error ? "not run" : c.tool === "ada_reference_check" ? "the ADA reference check" : what(c.changes)}`,
      }))] };
    case "run":
      return { ...t, runs: [...t.runs, e.run],
        steps: t.steps.map((s) => (s.key === e.run.id ? { ...s, state: "done", detail: outcome(e.run) } : s)) };
    case "run_error":
      return { ...t, steps: t.steps.map((s) => (s.key === e.id ? { ...s, state: "failed", detail: e.message } : s)) };
    case "answer":
      return { ...t, answer: e, steps: t.steps.map((s) => (s.state === "active" ? { ...s, state: "done" } : s)) };
    case "error":
      return { ...t, error: e.error.message, steps: t.steps.map((s) => (s.state === "active" ? { ...s, state: "failed" } : s)) };
  }
}

/** Ask Muse Spark about the room. Muse runs planner checks; nothing changes until a what-if is loaded. */
export function AssistantPanel({ scenario, metaConfigured, onLoad }: {
  scenario: RoomScenario; metaConfigured: boolean; onLoad: (run: AssistantRun) => void;
}) {
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const update = (fn: (t: Exchange) => Exchange) => setExchanges((xs) => [...xs.slice(0, -1), fn(xs[xs.length - 1])]);

  const ask = async () => {
    const room = JSON.stringify(scenario);
    const history: Turn[] = exchanges.filter((x) => x.answer).slice(-MAX_HISTORY).map((x) => ({
      question: x.question, answer: x.answer!.text, same_room: x.room === room, results: x.runs.map((r) => r.summary),
    }));
    const q = question.trim();
    setExchanges((xs) => [...xs, { question: q, room, steps: [], runs: [], answer: null, error: null }]);
    setQuestion("");
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const res = await fetch("/api/ai/assistant", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario, question: q, history }), signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        update((t) => ({ ...t, error: (body as ApiError | null)?.error?.message ?? `Error ${res.status}` }));
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) if (line.trim()) update((t) => fold(t, JSON.parse(line) as AssistantEvent));
      }
      update((t) => (t.answer || t.error ? t : { ...t, error: "The answer was cut off. Try again." }));
    } catch {
      update((t) => ({ ...t, error: ctrl.signal.aborted ? "Cancelled." : "Could not reach the SpaceAble server." }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  return (
    <Section title="Ask about your room">
      {exchanges.length > 0 && (
        <ol className="flex flex-col gap-3">
          {exchanges.map((x, i) => <ExchangeView key={i} x={x} live={busy && i === exchanges.length - 1} onLoad={onLoad} />)}
        </ol>
      )}
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        {exchanges.length ? "Ask a follow-up" : "Ask a question"}
        <textarea ref={box} value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} maxLength={1000}
          placeholder="What if I keep the dresser where it is too? I need 36 inches."
          className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:outline-2 focus:outline-indigo-500" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <MicButton disabled={!metaConfigured || busy} purpose="your question"
          keywords={[...new Set(scenario.objects.map((o) => o.label)), "wheelchair", "inches", "centimetres"]}
          onTranscript={(t) => { setQuestion((q) => (q.trim() ? `${q.trim()} ${t}` : t).slice(0, 1000)); box.current?.focus(); }} />
        <button className={button} disabled={!metaConfigured || busy || question.trim().length < 3} onClick={ask}>
          {busy ? "Working…" : "Ask"}
        </button>
        {busy && <button className={button} onClick={() => abort.current?.abort()}>Cancel</button>}
        {exchanges.length > 0 && !busy && (
          <button className={button} onClick={() => setExchanges([])}>New conversation</button>
        )}
      </div>
      <p className="text-xs text-slate-500">
        {metaConfigured
          ? "Muse Spark runs planner checks to answer. Nothing changes in your room unless you load a what-if."
          : "Needs MODEL_API_KEY on the server."}
      </p>
    </Section>
  );
}

function ExchangeView({ x, live, onLoad }: { x: Exchange; live: boolean; onLoad: (run: AssistantRun) => void }) {
  const done = x.steps.filter((s) => s.state !== "active").length;
  const max = x.steps.length + (x.answer || x.error ? 0 : 1); // the answer is always the last step
  const steps = (
    <ol className="flex flex-col gap-0.5 text-xs text-slate-600">
      {x.steps.map((s) => (
        <li key={s.key}>
          <span aria-hidden="true">{s.state === "done" ? "✓ " : s.state === "failed" ? "✗ " : "… "}</span>
          {s.label}{s.detail && <span className="text-slate-500"> ({s.detail})</span>}
        </li>
      ))}
    </ol>
  );
  return (
    <li className="flex flex-col gap-2 rounded border border-slate-200 p-2">
      <p className="text-sm font-medium text-slate-800">{x.question}</p>
      {live ? (
        <div className="flex flex-col gap-1">
          <progress className="h-2 w-full accent-indigo-600" value={done} max={Math.max(1, max)} aria-label="Assistant progress" />
          <div role="status" aria-live="polite">{steps}</div>
        </div>
      ) : x.steps.length > 0 && (
        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer">How this was checked ({x.steps.length} steps)</summary>
          {steps}
        </details>
      )}
      {x.error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{x.error}</p>}
      {x.answer && (
        <div className="rounded border border-slate-200 bg-white p-2 text-sm text-slate-800">
          <p className="mb-1 text-xs font-semibold text-slate-500">
            {x.answer.source === "muse"
              ? `Answered by Meta ${x.answer.model} · every number checked against the planner`
              : "Planner results only (no AI text)"}
          </p>
          <p>{x.answer.text}</p>
          {x.answer.note && <p className="mt-1 text-xs text-amber-800">{x.answer.note}</p>}
        </div>
      )}
      {x.runs.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="What-ifs the planner checked">
          {x.runs.map((run) => (
            <li key={run.id} className="flex flex-col gap-1 rounded border border-indigo-100 bg-indigo-50/50 p-2 text-xs text-slate-700">
              <span className="flex items-start justify-between gap-2">
                <span className="font-medium">{run.tool === "ada_reference_check" ? "ADA reference check" : `${VERB[run.tool][1]}: ${what(run.changes)}`}</span>
                <StatusBadge status={run.tool !== "find_layouts" ? (run.result as ValidationResult).status
                  : (run.result as OptimizationResult).alternatives.length ? "pass" : "fail"} />
              </span>
              <span>{outcome(run)}</span>
              <button className={`${button} self-start`} onClick={() => onLoad(run)}>Load this what-if</button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
