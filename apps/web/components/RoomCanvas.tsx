"use client";

import { useRef } from "react";
import { dims } from "@/lib/geometry-ui";
import type { Door, Furniture, RoomScenario, ValidationResult } from "@/lib/schema";

type Props = {
  scenario: RoomScenario;
  result: ValidationResult | null;
  stale: boolean;
  selectedId: string | null;
  lockedIds: string[];
  onSelect: (id: string | null) => void;
  onDrag: (id: string, x: number, y: number) => void;
  onKey: (id: string, e: React.KeyboardEvent) => void;
  /** Original placements of moved pieces, drawn as outlines with arrows to the new ones. */
  ghosts?: Furniture[];
  readOnly?: boolean;
};

const SNAP = 5;

export function RoomCanvas({ scenario, result, stale, selectedId, lockedIds, onSelect, onDrag, onKey,
  ghosts = [], readOnly = false }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; x0: number; y0: number; px: number; py: number } | null>(null);
  const { width_cm: W, height_cm: H } = scenario.room;
  const pad = Math.max(W, H) * 0.12;
  const fs = Math.max(W, H) / 38;
  const live = result && !stale ? result : null;
  const failing = new Set(
    (live?.checks ?? []).filter((c) => c.required && c.status === "fail").flatMap((c) => c.object_ids));

  const world = (e: React.PointerEvent) =>
    new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse());

  const down = (id: string, x: number, y: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (readOnly) return onSelect(id);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = world(e);
    drag.current = { id, x0: x, y0: y, px: p.x, py: p.y };
    onSelect(id);
  };
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const { id, x0, y0, px, py } = drag.current;
    const p = world(e);
    // snap the displacement, not the position: a click never moves a piece off its typed value
    const snap = (v: number) => (e.altKey ? Math.round(v) : Math.round(v / SNAP) * SNAP);
    onDrag(id, x0 + snap(p.x - px), y0 + snap(p.y - py));
  };

  return (
    <svg
      ref={svg}
      viewBox={`${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}`}
      className="h-full w-full touch-none select-none"
      role="group"
      aria-label={`Floor plan, ${W} by ${H} centimetres. Furniture can be focused and moved with arrow keys.`}
      onPointerMove={move}
      onPointerUp={() => (drag.current = null)}
      onPointerDown={() => onSelect(null)}
    >
      <defs>
        <pattern id="grid20" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" className="stroke-slate-200" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </pattern>
        <pattern id="grid100" width="100" height="100" patternUnits="userSpaceOnUse">
          <rect width="100" height="100" fill="url(#grid20)" />
          <path d="M 100 0 L 0 0 0 100" fill="none" className="stroke-slate-300" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </pattern>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="fill-indigo-700" />
        </marker>
        <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" className="stroke-red-500" strokeWidth="3" />
        </pattern>
      </defs>

      <rect x={0} y={0} width={W} height={H} className="fill-white" />
      <rect x={0} y={0} width={W} height={H} fill="url(#grid100)" />

      {/* planner evidence */}
      <g opacity={stale ? 0.25 : 1} aria-hidden="true">
        {(result?.reachable_area ?? []).map((poly, i) => (
          <path key={i} fillRule="evenodd" className="fill-emerald-400/20 stroke-emerald-500/60"
            strokeWidth="1" vectorEffect="non-scaling-stroke"
            d={poly.map((ring) => "M" + ring.map(([x, y]) => `${x},${y}`).join("L") + "Z").join(" ")} />
        ))}
        {(result?.routes ?? []).map((r) => r.target_rect && (
          <rect key={`t-${r.destination_id}`} x={r.target_rect[0]} y={r.target_rect[1]}
            width={r.target_rect[2] - r.target_rect[0]} height={r.target_rect[3] - r.target_rect[1]}
            className={r.status === "pass" ? "fill-sky-400/10 stroke-sky-600" : "fill-red-400/10 stroke-red-600"}
            strokeDasharray="6 4" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        ))}
        {(result?.routes ?? []).filter((r) => r.polyline.length > 1).map((r) => {
          const pts = r.polyline.map(([x, y]) => `${x},${y}`).join(" ");
          return (
            <g key={`r-${r.destination_id}`}>
              <polyline points={pts} fill="none" className="stroke-sky-500/25"
                strokeWidth={scenario.requirements.route_width_cm ?? 0}
                strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={pts} fill="none" className="stroke-sky-700" strokeWidth="2"
                vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
        {(result?.routes ?? []).slice(0, 1).map((r) => r.start && (
          <circle key="start" cx={r.start[0]} cy={r.start[1]} r={fs / 3} className="fill-sky-700" />
        ))}
        {(result?.turning_zones ?? []).map((z, i) => (
          <circle key={`z-${i}`} cx={z.center[0]} cy={z.center[1]} r={z.diameter_cm / 2}
            className={z.reachable ? "fill-violet-400/10 stroke-violet-600" : "fill-none stroke-amber-600"}
            strokeDasharray="8 5" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        ))}
      </g>

      {/* where moved pieces used to be */}
      {ghosts.map((g) => {
        const { w, h } = dims(g);
        return (
          <g key={`ghost-${g.id}`} aria-hidden="true" pointerEvents="none">
            <rect x={g.x_cm} y={g.y_cm} width={w} height={h} rx={2} className="fill-slate-200/50 stroke-slate-400"
              strokeDasharray="6 4" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            <text x={g.x_cm + w / 2} y={g.y_cm + h / 2} textAnchor="middle" fontSize={fs * 0.75}
              className="fill-slate-500">{g.label} (before)</text>
          </g>
        );
      })}

      {/* furniture */}
      {scenario.objects.map((o) => {
        const { w, h } = dims(o);
        const selected = o.id === selectedId;
        const bad = failing.has(o.id);
        const locked = lockedIds.includes(o.id);
        return (
          <g key={o.id} tabIndex={0} role="button" aria-pressed={selected}
            aria-label={`${o.label}, ${w} by ${h} cm at x ${o.x_cm}, y ${o.y_cm}${locked ? ", locked" : ""}${!o.movable ? ", fixed" : ""}${bad ? ", involved in a failed check" : ""}. Arrow keys move, R rotates, Delete removes.`}
            className={`${readOnly ? "cursor-default" : "cursor-move"} outline-none [&:focus-visible>rect:first-child]:stroke-indigo-500`}
            onPointerDown={down(o.id, o.x_cm, o.y_cm)}
            onFocus={() => onSelect(o.id)}
            onKeyDown={(e) => !readOnly && onKey(o.id, e)}>
            <rect x={o.x_cm} y={o.y_cm} width={w} height={h} rx={2}
              className={`${o.movable ? "fill-amber-100" : "fill-stone-300"} ${selected ? "stroke-indigo-600" : bad ? "stroke-red-600" : "stroke-stone-500"}`}
              strokeWidth={selected || bad ? 3 : 1.5} vectorEffect="non-scaling-stroke"
              strokeDasharray={o.confirmed ? undefined : "5 3"} />
            {bad && <rect x={o.x_cm} y={o.y_cm} width={w} height={h} fill="url(#hatch)" opacity={0.25} pointerEvents="none" />}
            <text x={o.x_cm + w / 2} y={o.y_cm + h / 2 - fs * 0.15} textAnchor="middle"
              fontSize={fs} className="fill-stone-800 font-medium" pointerEvents="none">
              {bad ? "⚠ " : ""}{o.label}{locked ? " (locked)" : ""}
            </text>
            <text x={o.x_cm + w / 2} y={o.y_cm + h / 2 + fs * 0.95} textAnchor="middle"
              fontSize={fs * 0.75} className="fill-stone-600" pointerEvents="none">
              {w}×{h}{o.confirmed ? "" : " (unconfirmed)"}
            </text>
          </g>
        );
      })}

      {ghosts.map((g) => {
        const now = scenario.objects.find((o) => o.id === g.id);
        if (!now) return null;
        const a = dims(g), b = dims(now);
        return (
          <line key={`arrow-${g.id}`} x1={g.x_cm + a.w / 2} y1={g.y_cm + a.h / 2}
            x2={now.x_cm + b.w / 2} y2={now.y_cm + b.h / 2} className="stroke-indigo-700"
            strokeWidth="2.5" vectorEffect="non-scaling-stroke" markerEnd="url(#arrow)" pointerEvents="none" />
        );
      })}

      {/* walls, doors, dimensions */}
      <rect x={0} y={0} width={W} height={H} fill="none" className="stroke-slate-800" strokeWidth="4" vectorEffect="non-scaling-stroke" pointerEvents="none" />
      {scenario.doors.map((d) => <DoorGlyph key={d.id} door={d} W={W} H={H} fs={fs} />)}
      <text x={W / 2} y={-fs * 0.8} textAnchor="middle" fontSize={fs} className="fill-slate-600">{W} cm</text>
      <text x={-fs * 0.8} y={H / 2} textAnchor="middle" fontSize={fs} className="fill-slate-600"
        transform={`rotate(-90 ${-fs * 0.8} ${H / 2})`}>{H} cm</text>
      <g aria-hidden="true">
        <line x1={0} y1={H + fs * 1.4} x2={100} y2={H + fs * 1.4} className="stroke-slate-700" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <line x1={0} y1={H + fs * 1.0} x2={0} y2={H + fs * 1.8} className="stroke-slate-700" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <line x1={100} y1={H + fs * 1.0} x2={100} y2={H + fs * 1.8} className="stroke-slate-700" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <text x={50} y={H + fs * 2.9} textAnchor="middle" fontSize={fs * 0.8} className="fill-slate-600">100 cm · grid 20 cm</text>
      </g>
    </svg>
  );
}

function DoorGlyph({ door, W, H, fs }: { door: Door; W: number; H: number; fs: number }) {
  const len = door.clear_width_cm ?? 0;
  const a = door.offset_cm;
  const vertical = door.wall === "left" || door.wall === "right";
  const fixed = door.wall === "left" ? 0 : door.wall === "right" ? W : door.wall === "top" ? 0 : H;
  const [x1, y1, x2, y2] = vertical ? [fixed, a, fixed, a + len] : [a, fixed, a + len, fixed];
  const inward = door.wall === "left" || door.wall === "top" ? 1 : -1;
  const mx = (x1 + x2) / 2 + (vertical ? inward * fs * 1.2 : 0);
  const my = (y1 + y2) / 2 + (vertical ? 0 : inward * fs * 1.2);
  return (
    <g pointerEvents="none">
      <line x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-white" strokeWidth="6" vectorEffect="non-scaling-stroke" />
      <line x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-sky-600" strokeWidth="2" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      <text x={mx} y={my} textAnchor="middle" dominantBaseline="middle" fontSize={fs * 0.75} className="fill-sky-800"
        transform={vertical ? `rotate(-90 ${mx} ${my})` : undefined}>
        {door.id} · {len ? `${len} cm` : "width?"}
      </text>
    </g>
  );
}
