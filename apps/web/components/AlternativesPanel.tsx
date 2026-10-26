"use client";

import { dims } from "@/lib/geometry-ui";
import type { Alternative, Furniture, Move, OptimizationResult, RoomScenario } from "@/lib/schema";
import { StatusBadge } from "./ValidationPanel";

const button =
  "rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-500";

function describe(m: Move, o: Furniture) {
  // direction of the footprint centre, consistent with distance_cm
  const centre = (x: number, y: number, rot: number) => {
    const { w, h } = dims({ ...o, rotation_deg: rot as Furniture["rotation_deg"] });
    return [x + w / 2, y + h / 2];
  };
  const [fx, fy] = centre(m.from_x_cm, m.from_y_cm, m.from_rotation_deg);
  const [tx, ty] = centre(m.to_x_cm, m.to_y_cm, m.to_rotation_deg);
  const dx = tx - fx;
  const dy = ty - fy;
  const dir = [dy < -2 ? "up" : dy > 2 ? "down" : "", dx < -2 ? "left" : dx > 2 ? "right" : ""]
    .filter(Boolean).join("-");
  const turned = m.to_rotation_deg !== m.from_rotation_deg
    ? `, turned to ${m.to_rotation_deg}°` : "";
  return `${o.label}: moved ${m.distance_cm} cm${dir ? ` ${dir}` : ""}${turned}`;
}

const HEADLINE: Record<OptimizationResult["status"], string> = {
  solutions_found: "Verified alternatives",
  no_solution_found_within_budget: "No verified solution within search limits",
  discretized_search_infeasible: "No verified layout among the placements tried",
  needs_input: "More information needed",
  error: "Optimization failed",
};

export function AlternativesPanel({ result, stale, scenario, previewId, onPreview, onUse }: {
  result: OptimizationResult; stale: boolean; scenario: RoomScenario; previewId: string | null;
  onPreview: (id: string | null) => void; onUse: (alt: Alternative) => void;
}) {
  const object = (id: string) => scenario.objects.find((o) => o.id === id)!;
  const s = result.search;
  return (
    <div aria-live="polite" className={`flex flex-col gap-2 ${stale ? "opacity-60" : ""}`}>
      {stale && (
        <p role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
          The layout changed since optimizing. Optimize again for current alternatives.
        </p>
      )}
      <div className="rounded border border-slate-200 bg-slate-50 p-2">
        <p className="text-sm font-semibold text-slate-800">
          {result.status === "discretized_search_infeasible" && s.candidates_tested === 0
            ? "Moving furniture cannot fix this" : HEADLINE[result.status]}
        </p>
        <p className="mt-1 text-xs text-slate-600">{result.message}</p>
        <p className="mt-1 text-xs tabular-nums text-slate-500">
          Ran the validator on {s.candidates_tested} of {s.combinations_considered} combinations considered, in {s.elapsed_s} s
          (limit {s.time_limit_s} s, {s.grid_spacing_cm} cm grid{s.exhaustive ? ", every combination checked" : ""}).
        </p>
      </div>
      {result.warnings.map((w) => (
        <p key={w} className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">⚠ {w}</p>
      ))}
      <ol className="flex flex-col gap-2">
        {result.alternatives.map((alt, i) => {
          const active = alt.id === previewId;
          return (
            <li key={alt.id} className={`rounded border p-2 ${active ? "border-indigo-500 bg-indigo-50" : "border-slate-200 bg-white"}`}>
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium text-slate-800">
                  {alt.moves.length ? `Option ${i + 1}` : "Current layout"}
                  <span className="font-normal text-slate-500">
                    {" "}· {alt.cost.moved_objects} moved · score {alt.cost.total_score}
                  </span>
                </span>
                <StatusBadge status={alt.validation.status} />
              </div>
              <ul className="mt-1 text-xs text-slate-600">
                {alt.moves.length
                  ? alt.moves.map((m) => <li key={m.object_id}>{describe(m, object(m.object_id))}</li>)
                  : <li>Nothing needs to move.</li>}
                <li className="tabular-nums text-slate-500">Required route length {alt.cost.route_length_cm} cm</li>
              </ul>
              {alt.moves.length > 0 && !stale && (
                <div className="mt-2 flex gap-2">
                  <button className={button} aria-pressed={active} onClick={() => onPreview(active ? null : alt.id)}>
                    {active ? "Stop preview" : "Preview"}
                  </button>
                  <button className={button} onClick={() => onUse(alt)}>Use this layout</button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
