"use client";

import { applyMoves, dims, fmtCm } from "@/lib/geometry-ui";
import type { Alternative, RoomScenario, ValidationResult } from "@/lib/schema";
import type { Explanation } from "./AiPanels";
import { RoomCanvas } from "./RoomCanvas";
import { DISCLAIMER, title } from "./ValidationPanel";

const STATUS = { pass: "✓ Pass", fail: "✗ Fail", needs_input: "? Needs input", not_checked: "– Not checked", unknown: "? Unknown" };

/** Printed instead of the app (see the print: classes in Planner). */
export function PrintSummary({ scenario, result, baseline, alternative, explanation, inches }: {
  scenario: RoomScenario; result: ValidationResult | null; baseline: ValidationResult | null;
  alternative: Alternative | null; explanation: Explanation | null; inches: boolean;
}) {
  const shownScenario = alternative ? applyMoves(scenario, alternative.moves) : scenario;
  const req = scenario.requirements;
  const cell = "border border-slate-300 px-2 py-1 text-left align-top";
  return (
    <article className="mx-auto max-w-3xl space-y-4 p-6 text-sm text-black">
      <header>
        <h1 className="text-xl font-bold">SpaceAble planning summary</h1>
        <p>{scenario.title ?? scenario.id} · printed {new Date().toLocaleDateString()}</p>
        <p className="mt-2 border border-black p-2 font-medium">Not a certification. {DISCLAIMER}</p>
      </header>

      <section>
        <h2 className="font-semibold">{alternative ? "Proposed layout" : "Current layout"}</h2>
        <div className="aspect-[4/3] w-full">
          <RoomCanvas scenario={shownScenario} result={result} stale={false} selectedId={null}
            lockedIds={req.locked_object_ids} readOnly inches={inches}
            ghosts={alternative ? scenario.objects.filter((o) => alternative.moves.some((m) => m.object_id === o.id)) : []} />
        </div>
      </section>

      <section>
        <h2 className="font-semibold">Room and requirements</h2>
        <p>
          Room {fmtCm(scenario.room.width_cm, inches)} × {fmtCm(scenario.room.height_cm, inches)}.
          Route width {req.route_width_cm === null ? "not set" : fmtCm(req.route_width_cm, inches)}; minimum door width{" "}
          {req.door_min_clear_width_cm === null ? "not set" : fmtCm(req.door_min_clear_width_cm, inches)}; turning circle{" "}
          {req.turning_diameter_cm === null ? "not checked" : fmtCm(req.turning_diameter_cm, inches)}.
        </p>
        <table className="mt-1 w-full border-collapse">
          <thead><tr>{["Furniture", "Size (cm)", "Position (cm)", "Rotation", "Notes"].map((h) => <th key={h} className={cell}>{h}</th>)}</tr></thead>
          <tbody>
            {shownScenario.objects.map((o) => {
              const { w, h } = dims(o);
              const notes = [!o.movable && "fixed", req.locked_object_ids.includes(o.id) && "locked",
                !o.confirmed && "unconfirmed size", o.label_source === "ai-inferred" && "added from photo"].filter(Boolean);
              return (
                <tr key={o.id}>
                  <td className={cell}>{o.label}</td><td className={cell}>{w} × {h}</td>
                  <td className={cell}>{o.x_cm}, {o.y_cm}</td><td className={cell}>{o.rotation_deg}°</td>
                  <td className={cell}>{notes.join(", ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {alternative && (
        <section>
          <h2 className="font-semibold">Changes</h2>
          <ul className="list-disc pl-5">
            {alternative.moves.map((m) => (
              <li key={m.object_id}>
                {scenario.objects.find((o) => o.id === m.object_id)?.label}: from ({m.from_x_cm}, {m.from_y_cm}) to ({m.to_x_cm}, {m.to_y_cm})
                {m.to_rotation_deg !== m.from_rotation_deg ? `, turned to ${m.to_rotation_deg}°` : ""}; centre moves {fmtCm(m.distance_cm, inches)}.
              </li>
            ))}
          </ul>
          {baseline && <p>Before the change: {STATUS[baseline.status]}.</p>}
        </section>
      )}

      {result ? (
        <section>
          <h2 className="font-semibold">Checks: {STATUS[result.status]}</h2>
          {result.widest_route_cm !== null && (
            <p>Routes stay verified up to {fmtCm(result.widest_route_cm, inches)} wide.</p>
          )}
          <table className="w-full border-collapse">
            <thead><tr>{["Check", "Result", "Measured", "Required", "Details"].map((h) => <th key={h} className={cell}>{h}</th>)}</tr></thead>
            <tbody>
              {result.checks.map((c) => (
                <tr key={c.id}>
                  <td className={cell}>{title(c)}{c.required ? "" : " (optional)"}</td>
                  <td className={cell}>{STATUS[c.status]}</td>
                  <td className={cell}>{c.measured_cm === null ? "" : fmtCm(c.measured_cm, inches)}</td>
                  <td className={cell}>{c.required_cm === null ? "" : `≥ ${fmtCm(c.required_cm, inches)}`}</td>
                  <td className={cell}>{c.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : <p>This layout has not been analysed.</p>}

      {explanation && (
        <section>
          <h2 className="font-semibold">Explanation ({explanation.source === "muse" ? `Meta ${explanation.model}, numbers checked against the planner` : "built-in, no AI"})</h2>
          <p>{explanation.text}</p>
        </section>
      )}

      {result && (
        <section>
          <h2 className="font-semibold">Assumptions</h2>
          <ul className="list-disc pl-5">{result.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </section>
      )}
    </article>
  );
}
