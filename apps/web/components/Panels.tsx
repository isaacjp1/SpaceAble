"use client";

import { KINDS, type Furniture, type RoomScenario, type Side } from "@/lib/schema";

/** Applies a mutation to a deep copy of the scenario. */
export type Update = (fn: (s: RoomScenario) => void) => void;

const SIDES: Side[] = ["top", "right", "bottom", "left"];
const input =
  "w-full min-w-0 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:outline-2 focus:outline-indigo-500";
const button =
  "rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50";

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-slate-200 p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function NumberField({ label, value, onCommit, nullable = false, min = 0, suffix = "cm", hint }: {
  label: string; value: number | null; onCommit: (v: number | null) => void;
  nullable?: boolean; min?: number; suffix?: string; hint?: string;
}) {
  const commit = (el: HTMLInputElement) => {
    const raw = el.value.trim();
    const v = Number(raw);
    if (raw === "" && nullable) onCommit(null);
    else if (raw !== "" && Number.isFinite(v) && v >= min) onCommit(v);
    else el.value = value === null ? "" : String(value); // reject: restore last good value
  };
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}
      <span className="flex items-center gap-1">
        {/* keyed by value: re-mounts with the new value when it changes elsewhere (e.g. drag) */}
        <input key={String(value)} type="number" inputMode="decimal" defaultValue={value ?? ""}
          min={min} step="any" className={input} placeholder={nullable ? "not set" : undefined}
          onBlur={(e) => commit(e.currentTarget)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        <span className="w-6 text-slate-500">{suffix}</span>
      </span>
      {hint && <span className="font-normal text-slate-500">{hint}</span>}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-indigo-600" />
      {label}
    </label>
  );
}

export function RoomPanel({ scenario, update }: { scenario: RoomScenario; update: Update }) {
  const door = scenario.doors[0];
  const editDoor = (patch: Partial<RoomScenario["doors"][number]>) =>
    update((s) => { s.doors[0] = { ...s.doors[0], ...patch, entry_anchor: undefined }; });
  return (
    <Section title="Room">
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Width" value={scenario.room.width_cm}
          onCommit={(v) => v && update((s) => { s.room.width_cm = v; })} />
        <NumberField label="Depth" value={scenario.room.height_cm}
          onCommit={(v) => v && update((s) => { s.room.height_cm = v; })} />
      </div>
      {door ? (
        <fieldset className="flex min-w-0 flex-col gap-2 rounded border border-slate-200 p-2">
          <legend className="px-1 text-xs font-medium text-slate-600">Entry door ({door.id})</legend>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Wall
            <select className={input} value={door.wall}
              onChange={(e) => editDoor({ wall: e.target.value as Side, offset_cm: 0 })}>
              {SIDES.map((w) => <option key={w}>{w}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="Offset along wall" value={door.offset_cm}
              onCommit={(v) => editDoor({ offset_cm: v ?? 0 })} />
            <NumberField label="Clear width" value={door.clear_width_cm} nullable
              onCommit={(v) => editDoor({ clear_width_cm: v })} />
          </div>
          <Toggle label="Door measurements confirmed" checked={door.confirmed}
            onChange={(v) => editDoor({ confirmed: v })} />
        </fieldset>
      ) : (
        <button className={button} onClick={() => update((s) => {
          s.doors.push({ id: "door-1", wall: "left", offset_cm: 0, clear_width_cm: null, confirmed: false });
        })}>Add entry door</button>
      )}
    </Section>
  );
}

const PRESETS: Record<string, [number, number]> = {
  bed: [140, 200], desk: [120, 60], dresser: [100, 50], chair: [50, 50], table: [90, 90],
  wardrobe: [100, 60], nightstand: [45, 40], sofa: [200, 90], shelf: [80, 30],
  obstacle: [60, 60], other: [60, 60],
};

/** New furniture at typical dimensions, marked unconfirmed until the user measures it. */
export function newFurniture(s: RoomScenario, kind: (typeof KINDS)[number], label: string,
  labelSource: Furniture["label_source"] = "user-provided"): Furniture {
  let n = 1;
  while (s.objects.some((o) => o.id === `${kind}-${n}`)) n++;
  const [w, h] = PRESETS[kind];
  return {
    id: `${kind}-${n}`, label, kind, width_cm: w, height_cm: h,
    x_cm: Math.max(0, Math.round((s.room.width_cm - w) / 2)),
    y_cm: Math.max(0, Math.round((s.room.height_cm - h) / 2)),
    rotation_deg: 0, movable: kind !== "obstacle",
    confirmed: false, // preset dimensions are estimates until measured
    label_source: labelSource,
  };
}

export function FurniturePanel({ scenario, selected, update, onSelect, onRotate, onDelete }: {
  scenario: RoomScenario; selected: Furniture | null; update: Update;
  onSelect: (id: string) => void; onRotate: (id: string) => void; onDelete: (id: string) => void;
}) {
  const add = (kind: (typeof KINDS)[number]) => {
    const o = newFurniture(scenario, kind, kind[0].toUpperCase() + kind.slice(1));
    update((s) => { s.objects.push(o); });
    onSelect(o.id);
  };
  const edit = (patch: Partial<Furniture>) => selected &&
    update((s) => { Object.assign(s.objects.find((o) => o.id === selected.id)!, patch); });
  const locked = selected ? scenario.requirements.locked_object_ids.includes(selected.id) : false;

  return (
    <Section title="Furniture">
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Add furniture (typical size, then measure)
        <select className={input} value="" onChange={(e) => e.target.value && add(e.target.value as (typeof KINDS)[number])}>
          <option value="">Choose a type…</option>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      <ul className="flex flex-wrap gap-1" aria-label="Furniture in room">
        {scenario.objects.map((o) => (
          <li key={o.id}>
            <button className={`${button} ${o.id === selected?.id ? "border-indigo-500 bg-indigo-50" : ""}`}
              aria-pressed={o.id === selected?.id} onClick={() => onSelect(o.id)}>{o.label}</button>
          </li>
        ))}
        {!scenario.objects.length && <li className="text-sm text-slate-500">The room is empty. Add furniture above.</li>}
      </ul>

      {selected ? (
        <fieldset className="flex min-w-0 flex-col gap-2 rounded border border-indigo-200 bg-indigo-50/40 p-2">
          <legend className="px-1 text-xs font-medium text-indigo-700">Selected: {selected.id}</legend>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
              Label
              <input key={selected.id + selected.label} className={input} defaultValue={selected.label} maxLength={80}
                onBlur={(e) => e.target.value.trim() && edit({ label: e.target.value.trim() })} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
              Type
              <select className={input} value={selected.kind}
                onChange={(e) => edit({ kind: e.target.value as Furniture["kind"] })}>
                {KINDS.map((k) => <option key={k}>{k}</option>)}
              </select>
            </label>
            <NumberField label="X (left edge)" value={selected.x_cm} onCommit={(v) => edit({ x_cm: v ?? 0 })} />
            <NumberField label="Y (top edge)" value={selected.y_cm} onCommit={(v) => edit({ y_cm: v ?? 0 })} />
            <NumberField label="Width" value={selected.width_cm} onCommit={(v) => v && edit({ width_cm: v })} />
            <NumberField label="Length" value={selected.height_cm} onCommit={(v) => v && edit({ height_cm: v })} />
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <button className={button} onClick={() => onRotate(selected.id)}>Rotate 90°</button>
            <span>now {selected.rotation_deg}°</span>
          </div>
          <Toggle label="Measurements confirmed" checked={selected.confirmed} onChange={(v) => edit({ confirmed: v })} />
          <Toggle label="Can be moved (off = fixed obstacle)" checked={selected.movable} onChange={(v) => edit({ movable: v })} />
          <Toggle label="Keep in place (lock)" checked={locked} onChange={(v) => update((s) => {
            const ids = s.requirements.locked_object_ids.filter((i) => i !== selected.id);
            s.requirements.locked_object_ids = v ? [...ids, selected.id] : ids;
          })} />
          <div className="flex gap-2">
            <button className={button} onClick={() => update((s) => {
              let n = 1;
              while (s.destinations.some((d) => d.id === `${selected.id}-approach${n > 1 ? `-${n}` : ""}`)) n++;
              const id = `${selected.id}-approach${n > 1 ? `-${n}` : ""}`;
              s.destinations.push({ id, object_id: selected.id, side: "bottom", approach_width_cm: 80, approach_depth_cm: 90, required: true });
              s.requirements.required_destination_ids.push(id);
            })}>Add approach zone</button>
            <button className={`${button} text-red-700`} onClick={() => onDelete(selected.id)}>Delete</button>
          </div>
        </fieldset>
      ) : (
        <p className="text-sm text-slate-500">Select furniture on the plan or in the list. Drag to move (snaps to 5 cm, hold Alt for 1 cm), or use arrow keys.</p>
      )}
    </Section>
  );
}

export function RequirementsPanel({ scenario, update }: { scenario: RoomScenario; update: Update }) {
  const req = scenario.requirements;
  const set = (patch: Partial<typeof req>) => update((s) => { Object.assign(s.requirements, patch); });
  const editDest = (id: string, patch: object) =>
    update((s) => { Object.assign(s.destinations.find((d) => d.id === id)!, patch); });
  return (
    <Section title="Your clearance needs">
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Route width" value={req.route_width_cm} nullable
          onCommit={(v) => set({ route_width_cm: v })} />
        <NumberField label="Min. door width" value={req.door_min_clear_width_cm} nullable
          onCommit={(v) => set({ door_min_clear_width_cm: v })} />
      </div>
      <NumberField label="Turning circle diameter (optional)" value={req.turning_diameter_cm} nullable
        onCommit={(v) => set({ turning_diameter_cm: v })}
        hint="Leave empty to skip. 152.4 cm (60 in) is one published reference, not a guarantee for your device." />
      <div>
        <p className="mb-1 text-xs font-medium text-slate-600">Places you need to reach</p>
        {!scenario.destinations.length && (
          <p className="text-sm text-slate-500">Select furniture and choose “Add approach zone”.</p>
        )}
        <ul className="flex flex-col gap-2">
          {scenario.destinations.map((d) => {
            const required = req.required_destination_ids.includes(d.id);
            return (
              <li key={d.id} className="rounded border border-slate-200 p-2">
                <div className="flex items-center justify-between gap-2">
                  <Toggle label={d.id} checked={required} onChange={(v) => update((s) => {
                    const ids = s.requirements.required_destination_ids.filter((i) => i !== d.id);
                    s.requirements.required_destination_ids = v ? [...ids, d.id] : ids;
                    s.destinations.find((x) => x.id === d.id)!.required = v; // keep the mirror in sync
                  })} />
                  <button className={button} aria-label={`Remove ${d.id}`} onClick={() => update((s) => {
                    s.destinations = s.destinations.filter((x) => x.id !== d.id);
                    s.requirements.required_destination_ids = s.requirements.required_destination_ids.filter((i) => i !== d.id);
                  })}>Remove</button>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                    <span title="Measured on the furniture before rotation; it turns with the piece">Side (unrotated)</span>
                    <select className={input} value={d.side} onChange={(e) => editDest(d.id, { side: e.target.value })}>
                      {SIDES.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </label>
                  <NumberField label="Width" value={d.approach_width_cm}
                    onCommit={(v) => v && editDest(d.id, { approach_width_cm: v })} />
                  <NumberField label="Depth" value={d.approach_depth_cm}
                    onCommit={(v) => v && editDest(d.id, { approach_depth_cm: v })} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}
