"use client";

import { useRef, useState } from "react";
import type { Proposal } from "@/lib/ai";
import type { ApiError, RoomScenario } from "@/lib/schema";
import { NumberField, Section, type Update } from "./Panels";

const button =
  "rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50";

type Review = {
  proposal: Proposal;
  model: string;
  form: Pick<Proposal, "locked_object_ids" | "required_destination_ids" | "route_width_cm" |
    "turning_diameter_cm" | "optimization_profile">;
};

/** Muse Spark turns a sentence into a constraint proposal the user edits and approves. */
export function RequestPanel({ scenario, update, metaConfigured }: {
  scenario: RoomScenario; update: Update; metaConfigured: boolean;
}) {
  const [text, setText] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const req = scenario.requirements;

  const interpret = async () => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setError(null);
    setReview(null);
    try {
      const res = await fetch("/api/ai/parse-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario, userText: text }),
        signal: ctrl.signal,
      });
      const body = await res.json();
      if (!res.ok) {
        setError((body as ApiError).error?.message ?? `Error ${res.status}`);
        return;
      }
      const p: Proposal = body.proposal;
      setReview({
        proposal: p, model: body.model, form: {
          locked_object_ids: p.locked_object_ids,
          required_destination_ids: p.required_destination_ids,
          route_width_cm: p.route_width_cm ?? req.route_width_cm, // null = not stated: keep current
          turning_diameter_cm: p.turning_diameter_cm ?? req.turning_diameter_cm,
          optimization_profile: p.optimization_profile,
        },
      });
    } catch {
      if (!ctrl.signal.aborted) setError("Could not reach the SpaceAble server.");
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const edit = (patch: Partial<Review["form"]>) => review && setReview({ ...review, form: { ...review.form, ...patch } });
  const toggle = (list: string[], id: string, on: boolean) => on ? [...list.filter((i) => i !== id), id] : list.filter((i) => i !== id);

  const apply = () => {
    if (!review) return;
    const f = review.form;
    update((s) => {
      const objects = new Set(s.objects.map((o) => o.id));
      const dests = new Set(s.destinations.map((d) => d.id));
      s.requirements.locked_object_ids = f.locked_object_ids.filter((i) => objects.has(i));
      s.requirements.required_destination_ids = f.required_destination_ids.filter((i) => dests.has(i));
      for (const d of s.destinations) d.required = s.requirements.required_destination_ids.includes(d.id);
      s.requirements.route_width_cm = f.route_width_cm;
      s.requirements.turning_diameter_cm = f.turning_diameter_cm;
      s.requirements.optimization_profile = f.optimization_profile;
    });
    setReview(null);
  };

  return (
    <Section title="Describe what you need">
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        In your own words
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1000}
          placeholder="Keep my bed where it is, but make the route to my desk clearer."
          className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:outline-2 focus:outline-indigo-500" />
      </label>
      <div className="flex items-center gap-2">
        <button className={button} disabled={!metaConfigured || busy || text.trim().length < 3} onClick={interpret}>
          {busy ? "Asking Muse…" : "Turn into requirements"}
        </button>
        {busy && <button className={button} onClick={() => abort.current?.abort()}>Cancel</button>}
      </div>
      {!metaConfigured && (
        <p className="text-xs text-slate-500">Needs MODEL_API_KEY on the server. You can set requirements by hand below.</p>
      )}
      {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{error}</p>}

      {review && (
        <fieldset aria-live="polite" className="flex min-w-0 flex-col gap-2 rounded border border-indigo-200 bg-indigo-50/50 p-2">
          <legend className="px-1 text-xs font-semibold text-indigo-800">Proposed by Meta {review.model}: review and edit</legend>
          <p className="text-xs font-medium text-slate-600">Keep in place</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {scenario.objects.map((o) => (
              <label key={o.id} className="flex items-center gap-1 text-sm text-slate-700">
                <input type="checkbox" className="accent-indigo-600" checked={review.form.locked_object_ids.includes(o.id)}
                  onChange={(e) => edit({ locked_object_ids: toggle(review.form.locked_object_ids, o.id, e.target.checked) })} />
                {o.label}
              </label>
            ))}
          </div>
          <p className="text-xs font-medium text-slate-600">Must be reachable</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {scenario.destinations.map((d) => (
              <label key={d.id} className="flex items-center gap-1 text-sm text-slate-700">
                <input type="checkbox" className="accent-indigo-600" checked={review.form.required_destination_ids.includes(d.id)}
                  onChange={(e) => edit({ required_destination_ids: toggle(review.form.required_destination_ids, d.id, e.target.checked) })} />
                {d.id}
              </label>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="Route width" value={review.form.route_width_cm} nullable
              onCommit={(v) => edit({ route_width_cm: v })}
              hint={review.proposal.route_width_cm === null ? "No new value in your request; keeping your current one." : "From your request."} />
            <NumberField label="Turning circle" value={review.form.turning_diameter_cm} nullable
              onCommit={(v) => edit({ turning_diameter_cm: v })}
              hint={review.proposal.turning_diameter_cm === null ? "No new value in your request; keeping your current one." : "From your request."} />
          </div>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Optimizer preference
            <select value={review.form.optimization_profile}
              onChange={(e) => edit({ optimization_profile: e.target.value as Proposal["optimization_profile"] })}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900">
              <option value="minimal_changes">Fewest changes</option>
              <option value="max_clearance">Most open space (not implemented yet; ranks by fewest changes)</option>
            </select>
          </label>
          {review.proposal.clarifying_questions.length > 0 && (
            <div className="text-xs text-slate-700">
              <p className="font-medium">Muse asks:</p>
              <ul className="list-disc pl-4">{review.proposal.clarifying_questions.map((q) => <li key={q}>{q}</li>)}</ul>
            </div>
          )}
          {review.proposal.unsupported_requests.length > 0 && (
            <div className="text-xs text-amber-900">
              <p className="font-medium">SpaceAble can&apos;t assess:</p>
              <ul className="list-disc pl-4">{review.proposal.unsupported_requests.map((q) => <li key={q}>{q}</li>)}</ul>
            </div>
          )}
          <div className="flex gap-2">
            <button className={`${button} border-indigo-500 text-indigo-800`} onClick={apply}>Apply to my requirements</button>
            <button className={button} onClick={() => setReview(null)}>Discard</button>
          </div>
        </fieldset>
      )}
    </Section>
  );
}

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
