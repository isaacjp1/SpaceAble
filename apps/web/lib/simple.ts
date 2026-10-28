// The iPhone app's simple flow: a mobility aid instead of measurements, default places to reach, and
// results in plain words. Every number comes from PROFILES or the planner; pass/fail from the planner.
import { DOOR, FORWARD, LONG, ROUTE, SHORT, TURN } from "./ada";
import { describeMove, dims } from "./geometry-ui";
import type { Destination, Furniture, Move, OptimizationResult, RoomScenario, Side, XY } from "./schema";

const SIDES: Side[] = ["top", "right", "bottom", "left"]; // clockwise
type Zone = Pick<Destination, "approach_width_cm" | "approach_depth_cm">;
const walking = (): Zone => ({ approach_width_cm: 80, approach_depth_cm: 90 });
const wheeled = (o: Furniture): Zone => (FORWARD.has(o.kind)
  ? { approach_width_cm: SHORT, approach_depth_cm: LONG } // forward at desks and tables
  : { approach_width_cm: LONG, approach_depth_cm: SHORT }); // side-on elsewhere

// Planning defaults, not clinical advice. Wheelchairs use the ADA reference values; the rest are
// engineering estimates for a person and their aid. Widths and turning circles in cm.
export const PROFILES = {
  wheelchair: { name: "Wheelchair", with: "a wheelchair", route: ROUTE, door: DOOR, turn: TURN, zone: wheeled },
  power_chair: { name: "Power chair or scooter", with: "a power chair or scooter", route: 100, door: DOOR, turn: 180, zone: wheeled },
  walker: { name: "Walker or rollator", with: "a walker", route: 90, door: DOOR, turn: null, zone: walking },
  crutches: { name: "Crutches", with: "crutches", route: 90, door: 76, turn: null, zone: walking },
  cane: { name: "Cane, or unsteady on my feet", with: "a cane", route: 75, door: 76, turn: null, zone: walking },
} as const;
export type Profile = keyof typeof PROFILES;
export const PROFILE_KEYS = Object.keys(PROFILES) as [Profile, ...Profile[]];

const REACH_KINDS = new Set(["bed", "desk", "table", "sofa", "wardrobe", "dresser"]);
const NOT_REACHED = /^(Fireplace|Stairs)\b/; // fixed, but nothing you walk up to use

/** The pieces a person usually needs to get to: furniture they use, and fixtures such as the toilet. */
export const defaultReach = (s: RoomScenario) => s.objects
  .filter((o) => !o.to_place && (REACH_KINDS.has(o.kind) || (o.kind === "obstacle" && !NOT_REACHED.test(o.label))))
  .map((o) => o.id).slice(0, 20); // the planner's 20-zone cap

/** The widest door or opening: the likeliest way in (a closet door is usually narrower). */
export const defaultDoor = (s: RoomScenario) =>
  s.doors.reduce<RoomScenario["doors"][number] | null>((a, d) => (!a || (d.clear_width_cm ?? 0) > (a.clear_width_cm ?? 0) ? d : a), null)?.id ?? null;

/** The side with the most floor in front of it (a bed: its long sides only), in the piece's own
 * unrotated frame so it turns with the piece. RoomPlan doesn't say which way furniture faces. */
export function approachSide(o: Furniture, room: RoomScenario["room"]): Side {
  const { w, h } = dims(o);
  const gap: Record<Side, number> = { top: o.y_cm, right: room.width_cm - o.x_cm - w, bottom: room.height_cm - o.y_cm - h, left: o.x_cm };
  const options: Side[] = o.kind !== "bed" ? SIDES : h >= w ? ["left", "right"] : ["top", "bottom"];
  const world = options.reduce((a, b) => (gap[b] > gap[a] ? b : a));
  return SIDES[(SIDES.indexOf(world) - o.rotation_deg / 90 + 4) % 4];
}

export interface Choices { profile: Profile; reach: string[]; keep: string[]; remove: string[]; startDoorId: string | null }

/** The room as the planner should check it: the person tapped "Looks right", so everything is
 * confirmed; requirements come from the profile; one required zone per piece they need to reach. */
export function planScenario(s: RoomScenario, c: Choices): RoomScenario {
  const p = PROFILES[c.profile];
  const objects = s.objects.filter((o) => !c.remove.includes(o.id)).map((o) => ({ ...o, confirmed: true }));
  const destinations: Destination[] = objects.filter((o) => c.reach.includes(o.id)).slice(0, 20).map((o) => ({
    id: `reach-${o.id}`.slice(0, 64), object_id: o.id, side: approachSide(o, s.room), ...p.zone(o), required: true,
  }));
  return {
    ...s,
    doors: s.doors.map((d) => ({ ...d, confirmed: true })),
    objects,
    destinations,
    requirements: {
      ...s.requirements,
      route_width_cm: p.route, door_min_clear_width_cm: p.door, turning_diameter_cm: p.turn,
      required_destination_ids: destinations.map((d) => d.id),
      locked_object_ids: c.keep.filter((id) => objects.some((o) => o.id === id)),
      start_door_id: c.startDoorId ?? defaultDoor(s),
    },
  };
}

// ---- results in plain words ---------------------------------------------------------------

/** Walls named as the person sees them walking in through the start door. */
export function wallNames(s: RoomScenario): Record<Side, string> {
  const door = s.doors.find((d) => d.id === s.requirements.start_door_id) ?? s.doors[0];
  if (!door) return { top: "the top wall", right: "the right wall", bottom: "the bottom wall", left: "the left wall" };
  const i = SIDES.indexOf(door.wall);
  const at = (k: number) => SIDES[(i + k) % 4];
  return {
    [at(0)]: "the wall with the door", [at(2)]: "the wall opposite the door",
    [at(1)]: "the wall on your left as you come in", [at(3)]: "the wall on your right as you come in",
  } as Record<Side, string>;
}

/** "Move the desk against the wall opposite the door", "Turn the sofa a quarter turn". */
export function moveStep(m: Move, o: Furniture, s: RoomScenario, walls = wallNames(s)): string {
  const name = o.label.toLowerCase();
  const quarter = Math.abs(m.to_rotation_deg - m.from_rotation_deg) % 180 === 90;
  const turn = m.to_rotation_deg === m.from_rotation_deg ? "" : quarter ? "a quarter turn" : "around";
  if (m.to_x_cm === m.from_x_cm && m.to_y_cm === m.from_y_cm) return `Turn the ${name} ${turn}`;
  const from = dims({ ...o, rotation_deg: m.from_rotation_deg as Furniture["rotation_deg"] });
  const { w, h } = dims({ ...o, rotation_deg: m.to_rotation_deg as Furniture["rotation_deg"] });
  const dx = m.to_x_cm + w / 2 - (m.from_x_cm + from.w / 2), dy = m.to_y_cm + h / 2 - (m.from_y_cm + from.h / 2);
  const toward: Side = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "bottom" : "top");
  const gap: Record<Side, number> = { top: m.to_y_cm, right: s.room.width_cm - m.to_x_cm - w,
    bottom: s.room.height_cm - m.to_y_cm - h, left: m.to_x_cm };
  const touching = SIDES.filter((k) => gap[k] <= 2);
  const where = touching.length
    ? `against ${walls[touching.includes(toward) ? toward : touching[0]]}` : `toward ${walls[toward]}`;
  return `Move the ${name} ${where}${turn ? `, and turn it ${turn}` : ""}`;
}

export interface Option { id: string; label: string; steps: string[]; moves: Move[]; routes: XY[][] }
export interface Summary { headline: string; options: Option[]; details: string[] }

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const cm = (v: number) => `${Math.round(v)} cm`;

/** What the planner found, for someone who doesn't want the measurements. `s` is the room the
 * planner checked; `doorNarrow` says the start door failed and was taken as it is. */
export function summarize(s: RoomScenario, r: OptimizationResult, profile: Profile, doorNarrow = false): Summary {
  const p = PROFILES[profile];
  const byId = new Map(s.objects.map((o) => [o.id, o]));
  const places = list(s.destinations.map((d) => `the ${byId.get(d.object_id)?.label.toLowerCase() ?? d.object_id}`));
  const walls = wallNames(s);
  const door = s.doors.find((d) => d.id === s.requirements.start_door_id);
  const alts = r.alternatives;

  const options: Option[] = alts.map((a) => ({
    id: a.id,
    label: a.id === "current" ? "As it is" : a.best_for?.length === 2 ? "Best option"
      : a.best_for?.includes("widest_route") ? "Most space" : "Fewest changes",
    steps: a.moves.length ? a.moves.flatMap((m) => (byId.has(m.object_id) ? [moveStep(m, byId.get(m.object_id)!, s, walls)] : []))
      : ["Nothing needs to move."],
    moves: a.moves,
    routes: a.validation.routes.map((x) => x.polyline).filter((l) => l.length > 1),
  }));

  const fewest = alts.find((a) => a.best_for?.includes("fewest_changes")) ?? alts[0];
  const turning = r.baseline.checks.find((c) => c.id === "turning-space");
  let headline: string;
  if (fewest?.id === "current") headline = `Your room already works with ${p.with}. Nothing needs to move.`;
  else if (fewest) {
    const n = fewest.moves.length;
    headline = `Move ${n === 1 ? "1 thing" : `${n} things`} and you can get from the door to ${places || "every part of the room"} with ${p.with}.`;
  } else if (r.status === "discretized_search_infeasible" && turning?.status === "fail") {
    headline = `The room is too small to turn ${p.with} around in, whatever you move.`;
  } else if (r.status === "needs_input") headline = r.message;
  else {
    headline = "We couldn't find a way to make enough room by moving up to 3 things." +
      (r.status === "no_solution_found_within_budget" ? " The search ran out of time, so there may still be one." : "");
  }
  if (doorNarrow) {
    headline = `The doorway looks narrower than ${p.with} needs. Check it with a tape measure: moving furniture can't fix that. ` +
      `Inside the room: ${headline.charAt(0).toLowerCase()}${headline.slice(1)}`;
  }

  const details = [
    `Planning for ${p.name.toLowerCase()}: paths ${cm(p.route)} wide, a doorway of ${cm(p.door)}` +
      `${p.turn ? `, room to turn in a ${cm(p.turn)} circle` : ""}. These are planning defaults, not clinical advice.`,
    ...(door?.clear_width_cm ? [`The doorway scanned at about ${cm(door.clear_width_cm)}. A scan measures the frame, which is wider than the opening.`] : []),
    ...alts.flatMap((a, i) => [
      ...(a.validation.widest_route_cm ? [`${options[i].label}: paths stay at least ${cm(a.validation.widest_route_cm)} wide.`] : []),
      ...a.moves.flatMap((m) => (byId.has(m.object_id) ? [describeMove(m, byId.get(m.object_id)!)] : [])),
    ]),
    r.message,
    "A planning aid from a simplified 2D model of your scan, not a safety guarantee. Check the room in person.",
  ];
  return { headline, options, details };
}
