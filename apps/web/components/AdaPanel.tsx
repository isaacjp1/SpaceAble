"use client";

import { ADA_NOTE, ADA_NOT_CHECKED, type AdaRow, adaCounts } from "@/lib/ada";
import { StatusBadge } from "./ValidationPanel";

const button =
  "rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-500";

/** The ADA reference check: each modelled rule with the planner's verdict, and what isn't checked. */
export function AdaPanel({ rows, onShow }: { rows: AdaRow[]; onShow: () => void }) {
  const { passed } = adaCounts(rows);
  return (
    <section aria-label="ADA reference check" className="flex flex-col gap-2 rounded border border-slate-200 bg-white p-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-slate-800">ADA 2010 reference check: {passed} of {rows.length} rules pass</p>
        <button className={button} onClick={onShow}>Show on the plan</button>
      </div>
      <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{ADA_NOTE}</p>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.rule} className="rounded border border-slate-200 p-2">
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-medium text-slate-800">{r.rule} {r.title}</span>
              <StatusBadge status={r.status} />
            </div>
            <p className="mt-1 text-xs text-slate-600">Requires {r.requirement}. {r.detail}</p>
            {r.note && <p className="mt-1 text-xs text-slate-500">{r.note}</p>}
          </li>
        ))}
      </ul>
      <details className="text-xs text-slate-600">
        <summary className="cursor-pointer font-medium">Not checked by SpaceAble ({ADA_NOT_CHECKED.length} areas)</summary>
        <ul className="mt-1 list-disc pl-4">
          {ADA_NOT_CHECKED.map(([rule, what]) => <li key={rule}>{rule}: {what}</li>)}
        </ul>
      </details>
    </section>
  );
}
