// Display-only helpers. Pass/fail always comes from the planner.
import type { Furniture, RoomScenario } from "./schema";

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Physical footprint after rotation: 90/270 swap width and height. */
export function dims(o: Pick<Furniture, "width_cm" | "height_cm" | "rotation_deg">) {
  return o.rotation_deg === 90 || o.rotation_deg === 270
    ? { w: o.height_cm, h: o.width_cm }
    : { w: o.width_cm, h: o.height_cm };
}

/** Keep the footprint's top-left inside the room (as far as its size allows). */
export function clampToRoom(o: Furniture, room: RoomScenario["room"]): Furniture {
  const { w, h } = dims(o);
  const x = Math.min(Math.max(0, o.x_cm), Math.max(0, room.width_cm - w));
  const y = Math.min(Math.max(0, o.y_cm), Math.max(0, room.height_cm - h));
  return { ...o, x_cm: r1(x), y_cm: r1(y) };
}

/** Rotate 90° clockwise about the footprint centre; (x, y) stays the new top-left. */
export function rotate(o: Furniture, room: RoomScenario["room"]): Furniture {
  const { w, h } = dims(o);
  const cx = o.x_cm + w / 2;
  const cy = o.y_cm + h / 2;
  const rotation_deg = ((o.rotation_deg + 90) % 360) as Furniture["rotation_deg"];
  const n = dims({ ...o, rotation_deg });
  return clampToRoom({ ...o, rotation_deg, x_cm: cx - n.w / 2, y_cm: cy - n.h / 2 }, room);
}

export const cmToIn = (cm: number) => cm / 2.54;
