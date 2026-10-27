"use client";

import { fmtCm } from "@/lib/geometry-ui";
import type { Check, Status, ValidationResult } from "@/lib/schema";

export const DISCLAIMER =
  "Planning preview based on confirmed dimensions and simplified 2D geometry. Not an accessibility " +
  "certification or safety guarantee. Verify in person and seek professional assessment where needed.";

const STATUS: Record<Status, { icon: string; label: string; cls: string }> = {
  pass: { icon: "✓", label: "Pass", cls: "bg-emerald-50 text-emerald-800 border-emerald-300" },
  fail: { icon: "✗", label: "Fail", cls: "bg-red-50 text-red-800 border-red-300" },
  needs_input: { icon: "?", label: "Needs input", cls: "bg-amber-50 text-amber-900 border-amber-300" },
  not_checked: { icon: "–", label: "Not checked", cls: "bg-slate-50 text-slate-600 border-slate-300" },
  unknown: { icon: "?", label: "Unknown", cls: "bg-slate-50 text-slate-600 border-slate-300" },
};

const OVERALL: Record<Status, string> = {
  pass: "Passes the configured geometric checks",
  fail: "Does not pass the configured checks",
  needs_input: "More information needed before a result",
  not_checked: "Not checked",
  unknown: "Unknown",
};

export function title(c: Check) {
  if (c.id.startsWith("approach-")) return `Approach zone: ${c.id.slice(9)}`;
  if (c.id.startsWith("route-")) return `Route to ${c.id.split("-to-").pop()}`;
  return ({
    "measurements-confirmed": "Measurements confirmed",
    "object-containment": "Furniture inside room",
    "object-collision": "No overlapping furniture",
    "door-clearance": "Door clear width",
    "destinations-selected": "Destination selected",
    "turning-space": "Turning space",
  } as Record<string, string>)[c.id] ?? c.id;
}

export function StatusBadge({ status }: { status: Status }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-semibold ${s.cls}`}>
      <span aria-hidden="true">{s.icon}</span>{s.label}
    </span>
  );
}

export function ValidationPanel({ result, stale, inches = false }: {
  result: ValidationResult | null; stale: boolean; inches?: boolean;
}) {
  return (
    <div aria-live="polite" className="flex flex-col gap-3">
      {!result ? (
        <p className="text-sm text-slate-500">Press <strong>Analyze</strong> to check this layout.</p>
      ) : (
        <>
          {stale && (
            <p role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
              The layout changed since this analysis. Analyze again for current results.
            </p>
          )}
          <div className={`rounded border p-3 ${STATUS[result.status].cls} ${stale ? "opacity-60" : ""}`}>
            <p className="text-sm font-semibold">
              <span aria-hidden="true">{STATUS[result.status].icon} </span>{OVERALL[result.status]}
            </p>
            <p className="mt-1 text-xs opacity-80">Planner analysis in {result.elapsed_ms} ms on a {result.grid_cm} cm grid.</p>
          </div>
          <ul className={`flex flex-col gap-2 ${stale ? "opacity-60" : ""}`}>
            {result.checks.map((c) => (
              <li key={c.id} className="rounded border border-slate-200 bg-white p-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-slate-800">
                    {title(c)}{!c.required && <span className="font-normal text-slate-500"> (optional)</span>}
                  </span>
                  <StatusBadge status={c.status} />
                </div>
                <p className="mt-1 text-xs text-slate-600">{c.message}</p>
                {(c.measured_cm !== null || c.required_cm !== null) && (
                  <p className="mt-1 text-xs tabular-nums text-slate-500">
                    {c.measured_cm !== null && <>measured {fmtCm(c.measured_cm, inches)}</>}
                    {c.measured_cm !== null && c.required_cm !== null && " · "}
                    {c.required_cm !== null && <>required ≥ {fmtCm(c.required_cm, inches)}</>}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {result.warnings.length > 0 && (
            <ul className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              {result.warnings.map((w) => <li key={w}>⚠ {w}</li>)}
            </ul>
          )}
          <details className="text-xs text-slate-600">
            <summary className="cursor-pointer font-medium">Assumptions ({result.assumptions.length})</summary>
            <ul className="mt-1 list-disc pl-4">{result.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          </details>
        </>
      )}
    </div>
  );
}
