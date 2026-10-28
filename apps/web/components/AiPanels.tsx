"use client";

export type Explanation = { source: "muse" | "template"; text: string; model?: string; note?: string };

export function ExplanationView({ explanation }: { explanation: Explanation }) {
  return (
    <div aria-live="polite" className="rounded border border-slate-200 bg-white p-2 text-sm text-slate-800">
      <p className="mb-1 text-xs font-semibold text-slate-500">
        {explanation.source === "muse"
          ? `Explained by Meta ${explanation.model} · every number checked against the planner`
          : "Built-in explanation (no AI)"}
      </p>
      <p>{explanation.text}</p>
      {explanation.note && <p className="mt-1 text-xs text-amber-800">{explanation.note}</p>}
    </div>
  );
}
