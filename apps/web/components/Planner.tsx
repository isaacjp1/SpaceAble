"use client";

import { useEffect, useRef, useState } from "react";
import fixture from "../../../shared/fixtures/canonical-bedroom.json";
import { clampToRoom, rotate } from "@/lib/geometry-ui";
import { RoomScenarioSchema, type ApiError, type RoomScenario, type ValidationResult } from "@/lib/schema";
import { FurniturePanel, RequirementsPanel, RoomPanel, Section, type Update } from "./Panels";
import { RoomCanvas } from "./RoomCanvas";
import { DISCLAIMER, ValidationPanel } from "./ValidationPanel";

const SAMPLE = RoomScenarioSchema.parse(fixture);

type Health = { planner: "ok" | "unreachable"; meta_configured: boolean };
type Analysis = { scenario: RoomScenario; result: ValidationResult };

const button =
  "rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-500";

export function Planner() {
  const [scenario, setScenario] = useState<RoomScenario>(SAMPLE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth)
      .catch(() => setHealth({ planner: "unreachable", meta_configured: false }));
  }, []);

  // Results belong to the exact scenario object they were computed for.
  const stale = analysis !== null && analysis.scenario !== scenario;
  const result = analysis?.result ?? null;
  const selected = scenario.objects.find((o) => o.id === selectedId) ?? null;
  const issues = RoomScenarioSchema.safeParse(scenario);

  const update: Update = (fn) =>
    setScenario((s) => {
      const next = structuredClone(s);
      fn(next);
      return next;
    });

  const moveTo = (id: string, x: number, y: number) =>
    update((s) => {
      const i = s.objects.findIndex((o) => o.id === id);
      s.objects[i] = clampToRoom({ ...s.objects[i], x_cm: x, y_cm: y }, s.room);
    });
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

  const analyze = async () => {
    const sent = scenario;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/planner/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: sent }),
      });
      const body = await res.json();
      if (!res.ok) setError((body as ApiError).error?.message ?? `Planner error ${res.status}`);
      else setAnalysis({ scenario: sent, result: body });
    } catch {
      setError("Could not reach the SpaceAble server.");
    } finally {
      setBusy(false);
    }
  };

  const exportJson = () => {
    const bundle = {
      format: "spaceable-export/1",
      exported_at: new Date().toISOString(),
      scenario,
      validation: stale ? null : result,
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
      setAnalysis(null);
      setSelectedId(null);
      setError(null);
    } catch {
      setError(`Could not load ${file.name}: not valid JSON.`);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <header className="no-print flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-4 py-2">
        <span className="text-lg font-bold tracking-tight text-indigo-700">SpaceAble</span>
        <span className="text-sm text-slate-600">{scenario.title ?? scenario.id}</span>
        <ServiceStatus health={health} />
        <div className="ml-auto flex flex-wrap gap-2">
          <button className={button} onClick={exportJson}>Save JSON</button>
          <button className={button} onClick={() => fileInput.current?.click()}>Load JSON</button>
          <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" aria-hidden="true"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ""; }} />
          <button className={button} onClick={() => { setScenario(SAMPLE); setAnalysis(null); setSelectedId(null); setError(null); }}>
            Reset sample
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
        <aside className="overflow-y-auto border-slate-200 bg-white lg:border-r" aria-label="Room setup">
          <RoomPanel scenario={scenario} update={update} />
          <FurniturePanel scenario={scenario} selected={selected} update={update}
            onSelect={setSelectedId} onRotate={rotateObj} onDelete={deleteObj} />
        </aside>

        <main className="flex min-h-[420px] flex-col gap-2 p-3">
          <div className="min-h-0 flex-1 rounded-lg border border-slate-200 bg-slate-50">
            <RoomCanvas scenario={scenario} result={result} stale={stale} selectedId={selectedId}
              lockedIds={scenario.requirements.locked_object_ids}
              onSelect={setSelectedId} onDrag={moveTo} onKey={onKey} />
          </div>
          <Legend />
        </main>

        <aside className="overflow-y-auto border-slate-200 bg-white lg:border-l" aria-label="Requirements and results">
          <RequirementsPanel scenario={scenario} update={update} />
          <Section title="Check this layout">
            {!issues.success && (
              <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                Fix before analyzing: {issues.error.issues[0].message}
              </p>
            )}
            <button onClick={analyze} disabled={busy}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60">
              {busy ? "Analyzing…" : "Analyze"}
            </button>
            {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</p>}
            <ValidationPanel result={result} stale={stale} />
          </Section>
        </aside>
      </div>

      <footer className="border-t border-slate-200 bg-white px-4 py-2 text-xs text-slate-600">
        <strong>Not a certification.</strong> {DISCLAIMER}
      </footer>
    </div>
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
