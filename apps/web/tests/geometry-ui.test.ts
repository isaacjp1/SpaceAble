import { describe, expect, it } from "vitest";
import { clampToRoom, dims, rotate } from "@/lib/geometry-ui";
import type { Furniture } from "@/lib/schema";

const room = { width_cm: 430, height_cm: 360 };
const desk: Furniture = {
  id: "desk", label: "Desk", kind: "desk", x_cm: 115, y_cm: 35, width_cm: 110, height_cm: 65,
  rotation_deg: 0, movable: true, confirmed: true, label_source: "user-provided", to_place: false,
};

describe("geometry-ui", () => {
  it("rotates 90° about the footprint centre and swaps dimensions", () => {
    const r = rotate(desk, room);
    expect(r.rotation_deg).toBe(90);
    expect(dims(r)).toEqual({ w: 65, h: 110 });
    expect([r.x_cm + 65 / 2, r.y_cm + 110 / 2]).toEqual([170, 67.5]);
    expect(rotate(rotate(rotate(r, room), room), room).rotation_deg).toBe(0);
  });

  it("clamps into the room", () => {
    expect(clampToRoom({ ...desk, x_cm: 400, y_cm: -20 }, room)).toMatchObject({ x_cm: 320, y_cm: 0 });
    // rotated near the top wall: clamped instead of going negative
    expect(rotate({ ...desk, y_cm: 0 }, room).y_cm).toBe(0);
  });
});
