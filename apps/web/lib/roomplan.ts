// Turns an Apple RoomPlan scan (CapturedRoom from the iPhone app) into a draft RoomScenario.
// A scan is a proposal: everything comes in unconfirmed, so the planner asks for input until the
// person has checked each item. Runs in the browser; the raw scan is never sent to the server.
import { z } from "zod";
import { clampToRoom, dims } from "./geometry-ui";
import { type Door, type Furniture, type Requirements, type RoomScenario, RoomScenarioSchema } from "./schema";

declare global {
  interface Window {
    webkit?: { messageHandlers?: { scanRoom?: { postMessage: (body: null) => void } } }; // the iOS app
    spaceableImportScan?: (raw: unknown) => string | null; // null on success, else a message
  }
}

// RoomPlan's CapturedRoom.Object.Category: kind, label, movable. RoomPlan has no desk category.
const CATEGORIES = {
  bed: ["bed", "Bed", true],
  table: ["table", "Table", true],
  chair: ["chair", "Chair", true],
  sofa: ["sofa", "Sofa", true],
  storage: ["other", "Storage", true],
  television: ["other", "Television", true],
  bathtub: ["obstacle", "Bathtub", false],
  toilet: ["obstacle", "Toilet", false],
  sink: ["obstacle", "Sink", false],
  stove: ["obstacle", "Stove", false],
  oven: ["obstacle", "Oven", false],
  refrigerator: ["obstacle", "Refrigerator", false],
  dishwasher: ["obstacle", "Dishwasher", false],
  washerDryer: ["obstacle", "Washer/dryer", false],
  fireplace: ["obstacle", "Fireplace", false],
  stairs: ["obstacle", "Stairs", false],
} as const satisfies Record<string, readonly [Furniture["kind"], string, boolean]>;
type Category = keyof typeof CATEGORIES;

const UNREADABLE = "This scan file isn't in a format SpaceAble understands.";
const NOT_RECTANGLE = "SpaceAble can only plan rectangular rooms for now, and the scanned walls don't form a rectangle.";

type Vec = [number, number];
type Item = { centre: Vec; axis: Vec; size: number[] }; // floor plane, metres

// Every assumption about how CapturedRoom encodes lives here, unconfirmed until a real scan:
// `transform` is a column-major 4×4 (16 numbers, or 4 columns of 4) with the translation at 12–14,
// `dimensions` is [x, y, z] in metres (a wall's length is x), `category` is like {"bed": {}}.
// ARKit is y-up; seen from above, +z points down the screen, so plan (x, y) = world (x, z).
const surface = z.object({
  transform: z.union([
    z.array(z.number()).length(16),
    z.array(z.array(z.number()).length(4)).length(4).transform((c) => c.flat()),
  ]),
  dimensions: z.array(z.number()).length(3),
});
const ScanSchema = z.object({
  walls: z.array(surface.extend({ curve: z.unknown().optional() })), // absent or null when straight
  doors: z.array(surface),
  openings: z.array(surface),
  objects: z.array(surface.extend({
    category: z.record(z.string(), z.unknown()).transform((c) => Object.keys(c)[0])
      .pipe(z.enum(Object.keys(CATEGORIES) as Category[])),
  })),
});

function readScan(raw: unknown) {
  const scan = ScanSchema.safeParse(raw);
  if (!scan.success) throw new Error(UNREADABLE);
  const item = ({ transform: t, dimensions }: z.infer<typeof surface>): Item => {
    const n = Math.hypot(t[0], t[2]); // the local x axis, projected onto the floor
    if (!(n > 1e-6)) throw new Error(UNREADABLE);
    return { centre: [t[12], t[14]], axis: [t[0] / n, t[2] / n], size: dimensions };
  };
  const { walls, doors, openings, objects } = scan.data;
  return {
    walls: walls.map((w) => ({ ...item(w), curved: w.curve != null })),
    doors: doors.map(item),
    openings: openings.map(item),
    objects: objects.map((o) => ({ ...item(o), category: o.category })),
  };
}

// Float32 values from the phone carry noise (3.2 m arrives as 3.2000000476…) that would tip floor/ceil.
const EPS = 1e-3; // cm
const down = (m: number) => Math.floor(m * 100 + EPS);
const up = (m: number) => Math.ceil(m * 100 - EPS);
const angle = ([x, y]: Vec) => (Math.atan2(y, x) * 180) / Math.PI; // degrees, clockwise on screen

export function capturedRoomToScenario(raw: unknown, keep: Requirements): { scenario: RoomScenario; warnings: string[] } {
  const scan = readScan(raw);
  const warnings: string[] = [];

  // Square up: the length-weighted mean wall direction, modulo 90°, becomes the x axis.
  let sin = 0, cos = 0;
  for (const w of scan.walls) {
    const a = 4 * Math.atan2(w.axis[1], w.axis[0]);
    sin += w.size[0] * Math.sin(a);
    cos += w.size[0] * Math.cos(a);
  }
  const t = -Math.atan2(sin, cos) / 4;
  const turn = ([x, y]: Vec): Vec => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
  const square = <T extends Item>(i: T): T => ({ ...i, centre: turn(i.centre), axis: turn(i.axis) });

  // Rectangular rooms only: a box drawn around an L-shape includes floor beyond the walls.
  // Every wall must lie on a side of the box (within 10 cm) and be square to it (within 5°).
  const walls = scan.walls.map(square);
  if (walls.some((w) => w.curved)) throw new Error("SpaceAble can only plan rectangular rooms for now, and this scan has a curved wall.");
  const offSquare = (a: Vec) => { const d = Math.abs(angle(a)) % 90; return Math.min(d, 90 - d); };
  if (walls.some((w) => offSquare(w.axis) > 5)) throw new Error(NOT_RECTANGLE);
  const ends = walls.map(({ centre: [x, y], axis: [ax, ay], size: [l] }): [Vec, Vec] =>
    [[x - (ax * l) / 2, y - (ay * l) / 2], [x + (ax * l) / 2, y + (ay * l) / 2]]);
  const xs = ends.flat().map((p) => p[0]), ys = ends.flat().map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const edges = [[0, x0], [0, x1], [1, y0], [1, y1]] as const;
  if (!ends.every(([p, q]) => edges.some(([k, v]) => Math.abs(p[k] - v) <= 0.1 && Math.abs(q[k] - v) <= 0.1)))
    throw new Error(NOT_RECTANGLE);
  const room = { width_cm: down(x1 - x0), height_cm: down(y1 - y0) }; // rounded down: conservative
  if (!(room.width_cm >= 1 && room.height_cm >= 1))
    throw new Error("The scan has no complete room outline. Scan again, walking along every wall.");
  if (room.width_cm > 3000 || room.height_cm > 3000)
    throw new Error("The scanned room is more than 30 m across, which is larger than SpaceAble can plan.");
  const plan = ([x, y]: Vec): Vec => [(x - x0) * 100, (y - y0) * 100]; // cm from the top-left corner

  // Doors and doorless openings go on the nearest wall. RoomPlan measures the frame, so the width is
  // optimistic compared with the clear opening; doors stay unconfirmed until measured.
  const doors: Door[] = [];
  for (const d of [...scan.doors, ...scan.openings].map(square)) {
    const [x, y] = plan(d.centre);
    const { width_cm: W, height_cm: H } = room;
    const [wall, along, length] = ([["top", x, W, y], ["bottom", x, W, H - y], ["left", y, H, x], ["right", y, H, W - x]] as const)
      .reduce((a, b) => (b[3] < a[3] ? b : a));
    const width = down(d.size[0]);
    if (width < 1 || width > length) {
      warnings.push(`A door on the ${wall} wall was left out: its scanned width (${width} cm) doesn't fit the wall.`);
      continue;
    }
    // offset_cm runs from the top for left/right walls, from the left otherwise
    const offset_cm = Math.min(Math.max(0, Math.round(along - width / 2)), length - width);
    doors.push({ id: `door-${doors.length + 1}`, wall, offset_cm, clear_width_cm: width, entry_anchor: null, confirmed: false });
  }
  if (doors.length > 8) warnings.push(`The scan found ${doors.length} doors and openings. SpaceAble keeps 8, so ${doors.length - 8} were left out.`);

  // Furniture boxes are "sized to the object's extremities", so rounding up errs on the safe side.
  let found = scan.objects.map(square).flatMap((o) => {
    const [kind, name, movable] = CATEGORIES[o.category];
    const yaw = angle(o.axis);
    const snapped = Math.round(yaw / 90) * 90;
    const rotation_deg = (((snapped % 360) + 360) % 360) as Furniture["rotation_deg"];
    const width_cm = up(o.size[0]), height_cm = up(o.size[2]);
    const { w, h } = dims({ width_cm, height_cm, rotation_deg });
    if (w > room.width_cm || h > room.height_cm) {
      warnings.push(`${name} (${w} × ${h} cm) is larger than the room and was left out.`);
      return [];
    }
    const [cx, cy] = plan(o.centre);
    const x = Math.round(cx - w / 2), y = Math.round(cy - h / 2);
    // scan noise pushes boxes a few cm into walls, which would fail containment
    const piece = clampToRoom({ id: "", label: name, kind, x_cm: x, y_cm: y, width_cm, height_cm, rotation_deg, movable,
      confirmed: false, label_source: "ai-inferred", to_place: false }, room);
    return [{ piece, name, turned: Math.abs(yaw - snapped), moved: Math.hypot(piece.x_cm - x, piece.y_cm - y) }];
  });
  if (found.length > 40) {
    const area = ({ piece: p }: (typeof found)[number]) => p.width_cm * p.height_cm;
    const largest = new Set([...found].sort((a, b) => area(b) - area(a)).slice(0, 40));
    warnings.push(`The scan found ${found.length} objects. SpaceAble keeps 40, so the ${found.length - 40} smallest were left out.`);
    found = found.filter((f) => largest.has(f));
  }

  const total = new Map<string, number>(), seen = new Map<string, number>();
  for (const f of found) total.set(f.name, (total.get(f.name) ?? 0) + 1);
  const objects = found.map(({ piece, name, turned, moved }) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    const label = total.get(name)! > 1 ? `${name} ${n}` : name;
    if (turned > 10) warnings.push(`${label} was ${Math.round(turned)}° off square and was turned to ${piece.rotation_deg}°.`);
    if (moved > 15) warnings.push(`${label} was moved ${Math.round(moved)} cm to fit inside the walls.`);
    return { ...piece, id: `${name.toLowerCase().replace(/\W+/g, "-")}-${n}`, label };
  });

  const scenario = RoomScenarioSchema.parse({
    id: `scan-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}`,
    version: 1,
    units: "cm",
    title: "Scanned room",
    room,
    doors: doors.slice(0, 8),
    objects,
    destinations: [], // the person adds the places they need to reach
    requirements: { // the old ids don't exist any more, so locks, destinations and the start door reset
      route_width_cm: keep.route_width_cm,
      door_min_clear_width_cm: keep.door_min_clear_width_cm,
      turning_diameter_cm: keep.turning_diameter_cm,
      optimization_profile: keep.optimization_profile,
    },
  });
  return { scenario, warnings };
}
