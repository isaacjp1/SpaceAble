"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import fixture from "../../../shared/fixtures/canonical-bedroom.json";
import { buildEvidence } from "@/lib/ai";
import { applyMoves, clampToRoom, rotate } from "@/lib/geometry-ui";
import {
  RoomScenarioSchema, type Alternative, type ApiError, type OptimizationResult, type RoomScenario,
  type ValidationResult,
} from "@/lib/schema";
import { type Explanation, ExplanationView, RequestPanel } from "./AiPanels";
import { AlternativesPanel } from "./AlternativesPanel";
import { FurniturePanel, RequirementsPanel, RoomPanel, Section, type Update } from "./Panels";
import { HelpDialog } from "./HelpDialog";
import { PhotoPanel } from "./PhotoPanel";
import { PrintSummary } from "./PrintSummary";
import { RoomCanvas } from "./RoomCanvas";
import { DISCLAIMER, StatusBadge, ValidationPanel } from "./ValidationPanel";

const SAMPLE = RoomScenarioSchema.parse(fixture);

// Browser persistence: the current room autosaves to SAVED. On load, the previous visit's room
// is moved to PREVIOUS first, so editing before choosing Restore can't overwrite it.
const SAVED = "spaceable:scenario";
const PREVIOUS = "spaceable:previous";
const listeners = new Set<() => void>();
const storage = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode / quota */ } },
  remove: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } listeners.forEach((l) => l()); },
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
};

type Health = { planner: "ok" | "unreachable"; meta_configured: boolean };
type Analysis = { scenario: RoomScenario; result: ValidationResult };
type Optimization = { scenario: RoomScenario; result: OptimizationResult };

const primary =
  "rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60";
const button =
  "rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-500";

export function Planner() {
  const [scenario, setScenario] = useState<RoomScenario>(SAMPLE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [optimization, setOptimization] = useState<Optimization | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [timeLimit, setTimeLimit] = useState(10);
  const [busy, setBusy] = useState<"analyze" | "optimize" | "explain" | null>(null);
  const [explanation, setExplanation] = useState<{ key: ValidationResult; data: Explanation } | null>(null);
  const [view, setView] = useState<"plan" | "photo">("plan");
  const [compare, setCompare] = useState(false);
  const [inches, setInches] = useState(false);
  const [printing, setPrinting] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const help = useRef<HTMLDialogElement>(null);
  const previous = useSyncExternalStore(storage.subscribe, () => storage.get(PREVIOUS), () => null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth)
      .catch(() => setHealth({ planner: "unreachable", meta_configured: false }));
  }, []);
  useEffect(() => { // runs before the autosave below on first render
    const saved = storage.get(SAVED);
    if (saved && saved !== JSON.stringify(SAMPLE)) storage.set(PREVIOUS, saved);
    listeners.forEach((l) => l());
  }, []);
  useEffect(() => storage.set(SAVED, JSON.stringify(scenario)), [scenario]);
  useEffect(() => { // render the print summary only for printing (Ctrl+P or the button)
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
  const restorable = (() => {
    if (!previous) return null;
    try { const r = RoomScenarioSchema.safeParse(JSON.parse(previous)); return r.success ? r.data : null; } catch { return null; }
  })();

  // Results belong to the exact scenario object they were computed for.
  const stale = analysis !== null && analysis.scenario !== scenario;
  const result = analysis?.result ?? null;
  const selected = scenario.objects.find((o) => o.id === selectedId) ?? null;
  const issues = RoomScenarioSchema.safeParse(scenario);
  const optStale = optimization !== null && optimization.scenario !== scenario;
  const preview = optStale ? undefined : optimization?.result.alternatives.find((a) => a.id === previewId);
  const previewIndex = preview ? optimization!.result.alternatives.indexOf(preview) + 1 : 0;
  const ghosts = preview ? scenario.objects.filter((o) => preview.moves.some((m) => m.object_id === o.id)) : [];

  const clearResults = () => {
    setAnalysis(null);
    setOptimization(null);
    setPreviewId(null);
    setSelectedId(null);
    setError(null);
  };

  const update: Update = (fn) =>
    setScenario((s) => {
      const next = structuredClone(s);
      fn(next);
      return next;
    });

  const moveTo = (id: string, x: number, y: number) => {
    const o = scenario.objects.find((p) => p.id === id)!;
    const moved = clampToRoom({ ...o, x_cm: x, y_cm: y }, scenario.room);
    if (moved.x_cm === o.x_cm && moved.y_cm === o.y_cm) return; // no-op: keep results fresh
    update((s) => { s.objects[s.objects.findIndex((p) => p.id === id)] = moved; });
  };
  const rotateObj = (id: string) =>
    update((s) => {
      const i = s.objects.findIndex((o) => o.id === id);
      s.objects[i] = rotate(s.objects[i], s.room);
    });
  const deleteObj = (id: string) => {
    update((s) => {
      const gone = new Set(s.destinations.filter((d) => d.object_id === id).map((d) => d.id));
      s.objects = s.objects.filter((o) => o.id !== id);
      s.destinations = s.destinations.filter((d) => !gone.has(d.id));
      s.requirements.required_destination_ids = s.requirements.required_destination_ids.filter((i) => !gone.has(i));
      s.requirements.locked_object_ids = s.requirements.locked_object_ids.filter((i) => i !== id);
    });
    setSelectedId(null);
  };
  const onKey = (id: string, e: React.KeyboardEvent) => {
    const o = scenario.objects.find((x) => x.id === id);
    if (!o) return;
    const step = e.shiftKey ? 20 : 5;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    if (arrows[e.key]) {
      e.preventDefault();
      moveTo(id, o.x_cm + arrows[e.key][0], o.y_cm + arrows[e.key][1]);
    } else if (e.key === "r" || e.key === "R") rotateObj(id);
    else if (e.key === "Delete" || e.key === "Backspace") deleteObj(id);
  };

  const call = async <T,>(kind: "analyze" | "optimize" | "explain", url: string, body: object): Promise<T | null> => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (res.ok) return data as T;
      setError((data as ApiError).error?.message ?? `Planner error ${res.status}`);
    } catch {
      if (!ctrl.signal.aborted) setError("Could not reach the SpaceAble server.");
    } finally {
      setBusy(null);
      abort.current = null;
    }
    return null;
  };

  const analyze = async () => {
    const sent = scenario;
    const result = await call<ValidationResult>("analyze", "/api/planner/analyze", { scenario: sent });
    if (result) setAnalysis({ scenario: sent, result });
  };

  const optimize = async () => {
    const sent = scenario;
    const result = await call<OptimizationResult>("optimize", "/api/planner/optimize", {
      scenario: sent, options: { time_limit_s: timeLimit },
    });
    if (!result) return;
    setOptimization({ scenario: sent, result });
    setAnalysis({ scenario: sent, result: result.baseline }); // same validator, same layout
    setPreviewId(null);
  };

  // The result currently on screen; explanations are tied to it.
  const shown = preview ? preview.validation : stale ? null : result;
  const explain = async () => {
    if (!shown) return;
    const opt = optStale ? null : optimization?.result ?? null; // the search behind what is shown
    const evidence = preview
      ? buildEvidence(scenario, optimization!.result.baseline, opt, preview)
      : buildEvidence(scenario, shown, opt);
    const data = await call<Explanation>("explain", "/api/ai/explain", { evidence });
    if (data) setExplanation({ key: shown, data });
  };

  const applyAlternative = (alt: Alternative) => {
    const next = applyMoves(scenario, alt.moves);
    setScenario(next);
    // alt.validation is the planner's analyze() of exactly this layout
    setAnalysis({ scenario: next, result: alt.validation });
    setOptimization(null);
    setPreviewId(null);
  };

  const exportJson = () => {
    const bundle = {
      format: "spaceable-export/1",
      exported_at: new Date().toISOString(),
      scenario, // the current layout; a selected alternative is applied via its layout
      validation: shown, // planner result for what is on screen (null if out of date)
      selected_alternative: preview ?? null,
      baseline: preview ? optimization!.result.baseline : null,
      explanation: explanation && explanation.key === shown ? explanation.data : null,
      disclaimer: DISCLAIMER,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `spaceable-${scenario.id}.json` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const parsed = RoomScenarioSchema.safeParse(data?.scenario ?? data);
      if (!parsed.success) {
        const i = parsed.error.issues[0];
        setError(`Could not load ${file.name}: ${i.path.join(".") || "scenario"}: ${i.message}`);
        return;
      }
      setScenario(parsed.data);
      clearResults();
    } catch {
      setError(`Could not load ${file.name}: not valid JSON.`);
    }
  };

  return (
    <>
    <div className="flex min-h-dvh flex-col lg:h-dvh print:hidden">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-4 py-2">
        <span className="text-lg font-bold tracking-tight text-indigo-700">SpaceAble</span>
        <span className="text-sm text-slate-600">{scenario.title ?? scenario.id}</span>
        <ServiceStatus health={health} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-sm text-slate-700">
            <input type="checkbox" className="accent-indigo-600" checked={inches} onChange={(e) => setInches(e.target.checked)} />
            Show inches
          </label>
          <button className={button} onClick={() => help.current?.showModal()}>Help &amp; limits</button>
          <button className={button} onClick={() => window.print()}>Print summary</button>
          <button className={button} onClick={exportJson}>Save JSON</button>
          <button className={button} onClick={() => fileInput.current?.click()}>Load JSON</button>
          <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" aria-hidden="true"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ""; }} />
          <button className={button} onClick={() => { setScenario(SAMPLE); clearResults(); }}>
            Reset sample
          </button>
        </div>
      </header>
      {restorable && (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-900">
          <span>Your room from last time (“{restorable.title ?? restorable.id}”) is saved in this browser.</span>
          <span className="ml-auto flex gap-2">
            <button className={button} onClick={() => { setScenario(restorable); clearResults(); storage.remove(PREVIOUS); }}>Restore it</button>
            <button className={button} onClick={() => storage.remove(PREVIOUS)}>Dismiss</button>
          </span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
        <aside className="overflow-y-auto border-slate-200 bg-white lg:border-r" aria-label="Room setup">
          <RoomPanel scenario={scenario} update={update} />
          <FurniturePanel scenario={scenario} selected={selected} update={update}
            onSelect={setSelectedId} onRotate={rotateObj} onDelete={deleteObj} />
        </aside>

        {/* on phones the plan comes first; the panels follow */}
        <main className="order-first flex min-h-[420px] flex-col gap-2 p-3 lg:order-none">
          <div aria-label="Workspace" className="flex gap-1">
            {(["plan", "photo"] as const).map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => setView(v)}
                className={`rounded-t border-b-2 px-3 py-1 text-sm font-medium ${view === v ? "border-indigo-600 text-indigo-800" : "border-transparent text-slate-600 hover:text-slate-900"}`}>
                {v === "plan" ? "Floor plan" : "Photo (SAM 3.1)"}
              </button>
            ))}
          </div>
          <div className={view === "photo" ? "min-h-0 flex-1" : "hidden"}>
            <PhotoPanel scenario={scenario} update={update} metaConfigured={health?.meta_configured ?? false} />
          </div>
          <div className={view === "plan" ? "flex min-h-0 flex-1 flex-col gap-2" : "hidden"}>
          {preview && (
            <div role="status" className="flex flex-wrap items-center gap-2 rounded border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
              <span>Previewing option {previewIndex} (read-only). Outlines show where moved pieces were.</span>
              <span className="ml-auto flex gap-2">
                <button className={button} aria-pressed={compare} onClick={() => setCompare(!compare)}>
                  {compare ? "Single view" : "Side by side"}
                </button>
                <button className={button} onClick={() => applyAlternative(preview)}>Use this layout</button>
                <button className={button} onClick={() => setPreviewId(null)}>Back to editing</button>
              </span>
            </div>
          )}
          {preview && compare ? (
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 md:grid-cols-2">
              {[
                { label: "Before", s: scenario, v: optimization!.result.baseline, g: [] },
                { label: `After: option ${previewIndex}`, s: applyMoves(scenario, preview.moves), v: preview.validation, g: ghosts },
              ].map(({ label, s, v, g }) => (
                <figure key={label} className="flex min-h-[300px] flex-col rounded-lg border border-slate-200 bg-slate-50 p-2">
                  <figcaption className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                    {label} <StatusBadge status={v.status} />
                    <span className="text-xs font-normal text-slate-600">
                      {v.checks.filter((c) => c.required && c.id.startsWith("route-")).map((c) => c.message).join(" ")}
                    </span>
                  </figcaption>
                  <div className="min-h-0 flex-1">
                    <RoomCanvas scenario={s} result={v} stale={false} selectedId={null}
                      lockedIds={scenario.requirements.locked_object_ids} ghosts={g} readOnly inches={inches} />
                  </div>
                </figure>
              ))}
            </div>
          ) : (
          <div className="min-h-0 flex-1 rounded-lg border border-slate-200 bg-slate-50">
            <RoomCanvas scenario={preview ? applyMoves(scenario, preview.moves) : scenario}
              result={preview ? preview.validation : result} stale={preview ? false : stale}
              selectedId={selectedId} lockedIds={scenario.requirements.locked_object_ids}
              onSelect={setSelectedId} onDrag={moveTo} onKey={onKey}
              ghosts={ghosts} readOnly={Boolean(preview)} inches={inches} />
          </div>
          )}
          <Legend />
          </div>
        </main>

        <aside className="overflow-y-auto border-slate-200 bg-white lg:border-l" aria-label="Requirements and results">
          <RequestPanel scenario={scenario} update={update} metaConfigured={health?.meta_configured ?? false} />
          <RequirementsPanel scenario={scenario} update={update} />
          <Section title="Check this layout">
            {!issues.success && (
              <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                Fix before analyzing: {issues.error.issues[0].message}
              </p>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <button onClick={analyze} disabled={busy !== null} className={primary}>
                {busy === "analyze" ? "Analyzing…" : "Analyze"}
              </button>
              <button onClick={optimize} disabled={busy !== null} className={primary}>
                {busy === "optimize" ? "Searching…" : "Optimize"}
              </button>
              <button onClick={explain} disabled={busy !== null || !shown} className={button}>
                {busy === "explain" ? "Explaining…" : "Explain"}
              </button>
              {busy && <button onClick={() => abort.current?.abort()} className={button}>Cancel</button>}
              <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                Search time limit
                <select value={timeLimit} onChange={(e) => setTimeLimit(Number(e.target.value))}
                  className="rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900">
                  {[5, 10, 20].map((t) => <option key={t} value={t}>{t} s</option>)}
                </select>
              </label>
            </div>
            {busy === "optimize" && (
              <p className="text-xs text-slate-500">Searching for up to {timeLimit} s. Cancel stops waiting; the planner finishes its current search on its own.</p>
            )}
            {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</p>}
            {explanation && explanation.key === shown && <ExplanationView explanation={explanation.data} />}
            {optimization && (
              <AlternativesPanel result={optimization.result} stale={optStale} scenario={scenario}
                previewId={preview?.id ?? null} onPreview={setPreviewId} onUse={applyAlternative} />
            )}
            <ValidationPanel result={preview ? preview.validation : result} stale={preview ? false : stale} inches={inches} />
          </Section>
        </aside>
      </div>

      <footer className="border-t border-slate-200 bg-white px-4 py-2 text-xs text-slate-600">
        <strong>Not a certification.</strong> {DISCLAIMER}
      </footer>
      <HelpDialog ref={help} />
    </div>
    {printing && <div className="hidden print:block">
      <PrintSummary scenario={scenario} result={shown} baseline={preview ? optimization!.result.baseline : null}
        alternative={preview ?? null} explanation={explanation && explanation.key === shown ? explanation.data : null}
        inches={inches} />
    </div>}
    </>
  );
}

function ServiceStatus({ health }: { health: Health | null }) {
  const pill = "rounded-full border px-2 py-0.5 text-xs font-medium";
  if (!health) return <span className={`${pill} border-slate-300 text-slate-500`}>Checking services…</span>;
  return (
    <span className="flex gap-2">
      <span className={`${pill} ${health.planner === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-800"}`}>
        Planner: {health.planner === "ok" ? "online" : "offline"}
      </span>
      <span className={`${pill} ${health.meta_configured ? "border-indigo-300 bg-indigo-50 text-indigo-800" : "border-amber-300 bg-amber-50 text-amber-900"}`}
        title={health.meta_configured ? "MODEL_API_KEY is set on the server" : "Manual planning works; AI features need MODEL_API_KEY on the server"}>
        Meta AI: {health.meta_configured ? "configured" : "not configured (manual mode)"}
      </span>
    </span>
  );
}

function Legend() {
  const item = "flex items-center gap-1.5";
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="Plan legend">
      <li className={item}><span className="h-3 w-5 rounded-sm bg-sky-500/30" /> verified route (band = route width)</li>
      <li className={item}><span className="h-3 w-5 rounded-sm border border-emerald-500 bg-emerald-400/20" /> route centre can reach (from door)</li>
      <li className={item}><span className="h-3 w-5 rounded-sm border border-dashed border-sky-600" /> approach zone</li>
      <li className={item}><span className="h-3 w-5 rounded-sm border-2 border-red-600" /> ⚠ in a failed check</li>
      <li className={item}><span className="h-3 w-5 rounded-sm border border-dashed border-stone-500 bg-amber-100" /> unconfirmed size</li>
      <li className={item}><span className="h-3 w-5 rounded-sm bg-stone-300" /> fixed obstacle</li>
    </ul>
  );
}
