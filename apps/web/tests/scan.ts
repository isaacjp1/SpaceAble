// Builds RoomPlan-shaped scans in the encoding lib/roomplan.ts assumes (see readScan there).
// Elements are placed in room coordinates (metres, x right, z down the plan, yaw clockwise),
// then the whole scan can be turned and shifted, as a phone's world origin would be.
type El = { at: [number, number]; yaw?: number; size: [number, number, number] };
export type ScanSpec = { walls: El[]; doors?: El[]; openings?: El[]; objects?: (El & { category: string })[] };

/** Four straight walls of a w × h metre room with its top-left corner at the origin. */
export const box = (w: number, h: number): El[] => [
  { at: [w / 2, 0], yaw: 0, size: [w, 2.4, 0] },
  { at: [w, h / 2], yaw: 90, size: [h, 2.4, 0] },
  { at: [w / 2, h], yaw: 180, size: [w, 2.4, 0] },
  { at: [0, h / 2], yaw: 270, size: [h, 2.4, 0] },
];

export function buildScan(spec: ScanSpec, turnDeg = 0, [dx, dz] = [0, 0]) {
  const t = (turnDeg * Math.PI) / 180;
  const el = ({ at: [x, z], yaw = 0, size }: El) => {
    const r = ((yaw + turnDeg) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return {
      identifier: crypto.randomUUID(),
      // column-major; local x = (c, 0, s), y up, z = x × y
      transform: [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0,
        x * Math.cos(t) - z * Math.sin(t) + dx, 1.2, x * Math.sin(t) + z * Math.cos(t) + dz, 1],
      dimensions: size,
      confidence: { high: {} },
    };
  };
  return {
    identifier: crypto.randomUUID(),
    version: 2,
    walls: spec.walls.map((w) => ({ ...el(w), category: { wall: {} }, curve: null })),
    doors: (spec.doors ?? []).map((d) => ({ ...el(d), category: { door: { isOpen: false } } })),
    windows: [],
    openings: (spec.openings ?? []).map((o) => ({ ...el(o), category: { opening: {} } })),
    floors: [],
    objects: (spec.objects ?? []).map(({ category, ...o }) => ({ ...el(o), category: { [category]: {} } })),
    sections: [],
  };
}
