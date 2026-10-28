import { describe, expect, it } from "vitest";
import { capturedRoomToScenario } from "@/lib/roomplan";
import { RequirementsSchema, RoomScenarioSchema } from "@/lib/schema";
import { box, buildScan, type ScanSpec } from "./scan";

const keep = RequirementsSchema.parse({ route_width_cm: 80, door_min_clear_width_cm: 75 });
const convert = (spec: ScanSpec, turn = 0) => capturedRoomToScenario(buildScan(spec, turn, [5, -2]), keep);
const bed = { category: "bed", size: [1.4, 0.5, 2] as [number, number, number] };

describe("squaring up the room", () => {
  it("turns a room scanned at an angle back to axis-aligned, rounding its size down", () => {
    const { scenario, warnings } = convert({ walls: box(4, 3), objects: [{ ...bed, at: [1, 1] }] }, 30);
    expect(scenario.room).toEqual({ width_cm: 400, height_cm: 300 });
    expect(scenario.objects[0]).toMatchObject({ x_cm: 30, y_cm: 0, width_cm: 140, height_cm: 200, rotation_deg: 0 });
    expect(warnings).toEqual([]);
  });

  it("rejects L-shaped, curved and slanted rooms instead of planning a box around them", () => {
    const l = [
      { at: [2, 0], yaw: 0, size: [4, 2.4, 0] }, { at: [4, 0.75], yaw: 90, size: [1.5, 2.4, 0] },
      { at: [3, 1.5], yaw: 180, size: [2, 2.4, 0] }, { at: [2, 2.25], yaw: 90, size: [1.5, 2.4, 0] },
      { at: [1, 3], yaw: 180, size: [2, 2.4, 0] }, { at: [0, 1.5], yaw: 270, size: [3, 2.4, 0] },
    ] satisfies ScanSpec["walls"];
    expect(() => convert({ walls: l })).toThrow(/only plan rectangular rooms/);
    const curved = buildScan({ walls: box(4, 3) });
    Object.assign(curved.walls[1], { curve: { radius: 2 } });
    expect(() => capturedRoomToScenario(curved, keep)).toThrow(/curved wall/);
    const slanted = box(4, 3);
    slanted[1] = { ...slanted[1], yaw: 100 };
    expect(() => convert({ walls: slanted })).toThrow(/only plan rectangular rooms/);
    expect(() => convert({ walls: [] })).toThrow(/no complete room outline/);
  });
});

describe("doors", () => {
  it("puts each door on its nearest wall, measured from the top or the left", () => {
    const { scenario } = convert({
      walls: box(4, 3),
      doors: [
        { at: [1.5, 0], size: [0.9, 2, 0] },
        { at: [4, 2], yaw: 90, size: [0.8, 2, 0] },
        { at: [0, 0.5], yaw: 270, size: [0.8, 2, 0] },
        { at: [3.9, 0], size: [0.9, 2, 0] }, // overhangs the corner: clamped along the wall
      ],
      openings: [{ at: [3, 3], yaw: 180, size: [1, 2, 0] }],
    });
    expect(scenario.doors.map((d) => [d.id, d.wall, d.offset_cm, d.clear_width_cm])).toEqual([
      ["door-1", "top", 105, 90], ["door-2", "right", 160, 80], ["door-3", "left", 10, 80],
      ["door-4", "top", 310, 90], ["door-5", "bottom", 250, 100],
    ]);
    expect(scenario.doors.every((d) => d.confirmed === false && d.entry_anchor === null)).toBe(true);
  });

  it("keeps at most 8", () => {
    const doors = Array.from({ length: 9 }, (_, i) => ({ at: [0.5 + i, 0] as [number, number], size: [0.8, 2, 0] as [number, number, number] }));
    const { scenario, warnings } = convert({ walls: box(10, 10), doors });
    expect(scenario.doors).toHaveLength(8);
    expect(warnings).toContain("The scan found 9 doors and openings. SpaceAble keeps 8, so 1 were left out.");
  });
});

describe("furniture", () => {
  it("snaps to the nearest quarter turn, swapping the footprint, and warns when that moved it far", () => {
    const { scenario, warnings } = convert({
      walls: box(4, 3),
      objects: [
        // float32 sizes as the phone sends them: 0.6 arrives as 0.6000000238…, still 60 cm
        { category: "table", at: [2, 1.5], yaw: 88, size: [Math.fround(1.2), 0.75, Math.fround(0.6)] },
        { category: "chair", at: [1, 2], yaw: -75, size: [0.5, 0.9, 0.5] },
      ],
    });
    expect(scenario.objects[0]).toMatchObject({ id: "table-1", label: "Table", kind: "table", rotation_deg: 90,
      width_cm: 120, height_cm: 60, x_cm: 170, y_cm: 90 });
    expect(scenario.objects[1]).toMatchObject({ rotation_deg: 270 });
    expect(warnings).toEqual(["Chair was 15° off square and was turned to 270°."]);
  });

  it("clamps pieces into the room, warning only when one moved far, and drops pieces bigger than the room", () => {
    const { scenario, warnings } = convert({
      walls: box(4, 3),
      objects: [
        { ...bed, at: [0.65, 1.5] }, // 5 cm into the left wall
        { category: "sofa", at: [2, 2.8], size: [2, 0.8, 0.9] }, // 25 cm into the bottom wall
        { category: "bed", at: [2, 1.5], size: [5, 0.5, 2] },
      ],
    });
    expect(scenario.objects.map((o) => [o.label, o.x_cm, o.y_cm])).toEqual([["Bed", 0, 50], ["Sofa", 100, 210]]);
    expect(warnings).toEqual([
      "Bed (500 × 200 cm) is larger than the room and was left out.",
      "Sofa was moved 25 cm to fit inside the walls.",
    ]);
  });

  it("imports fixtures as fixed obstacles and everything unconfirmed, with numbered labels", () => {
    const size: [number, number, number] = [0.5, 0.9, 0.5];
    const { scenario } = convert({
      walls: box(4, 3),
      objects: [
        { category: "toilet", at: [0.5, 0.5], size }, { category: "washerDryer", at: [1.5, 0.5], size },
        { category: "chair", at: [2.5, 0.5], size }, { category: "chair", at: [3.5, 0.5], size },
      ],
    });
    expect(scenario.objects.map((o) => [o.id, o.label, o.kind, o.movable])).toEqual([
      ["toilet-1", "Toilet", "obstacle", false], ["washer-dryer-1", "Washer/dryer", "obstacle", false],
      ["chair-1", "Chair 1", "chair", true], ["chair-2", "Chair 2", "chair", true],
    ]);
    expect(scenario.objects.every((o) => !o.confirmed && o.label_source === "ai-inferred" && !o.to_place)).toBe(true);
  });

  it("keeps the 40 largest pieces", () => {
    const objects = [
      ...Array.from({ length: 3 }, () => ({ category: "storage", at: [1, 1] as [number, number], size: [0.2, 0.2, 0.2] as [number, number, number] })),
      ...Array.from({ length: 40 }, () => ({ category: "chair", at: [2, 2] as [number, number], size: [0.5, 0.9, 0.5] as [number, number, number] })),
    ];
    const { scenario, warnings } = convert({ walls: box(4, 3), objects });
    expect(scenario.objects).toHaveLength(40);
    expect(scenario.objects.every((o) => o.kind === "chair")).toBe(true);
    expect(warnings).toEqual(["The scan found 43 objects. SpaceAble keeps 40, so the 3 smallest were left out."]);
  });
});

describe("the scenario", () => {
  it("is a valid draft that keeps the person's widths and resets ids that no longer exist", () => {
    const old = RequirementsSchema.parse({ route_width_cm: 90, door_min_clear_width_cm: 80, turning_diameter_cm: 150,
      optimization_profile: "max_clearance", locked_object_ids: ["bed"], required_destination_ids: ["bed-side"], start_door_id: "door-1" });
    const { scenario } = capturedRoomToScenario(buildScan({ walls: box(4, 3), objects: [{ ...bed, at: [1, 1] }] }), old);
    expect(RoomScenarioSchema.safeParse(scenario).success).toBe(true);
    expect(scenario).toMatchObject({ title: "Scanned room", version: 1, units: "cm", destinations: [] });
    expect(scenario.id).toMatch(/^scan-\d{8}-\d{4}$/);
    expect(scenario.requirements).toEqual({ route_width_cm: 90, door_min_clear_width_cm: 80, turning_diameter_cm: 150,
      optimization_profile: "max_clearance", locked_object_ids: [], required_destination_ids: [], start_door_id: null });
  });

  it("accepts the transform as 4 columns of 4 too", () => {
    const flat = buildScan({ walls: box(4, 3), objects: [{ ...bed, at: [1, 1], yaw: 90 }] }, 30);
    const nested = structuredClone(flat) as { walls: { transform: unknown }[]; objects: { transform: unknown }[] };
    for (const e of [...nested.walls, ...nested.objects]) {
      const t = e.transform as number[];
      e.transform = [0, 4, 8, 12].map((i) => t.slice(i, i + 4));
    }
    expect(capturedRoomToScenario(nested, keep).scenario.objects).toEqual(capturedRoomToScenario(flat, keep).scenario.objects);
  });

  it("refuses anything that isn't a scan in the expected format, without guessing", () => {
    const unknown = buildScan({ walls: box(4, 3), objects: [{ category: "beanbag", at: [1, 1], size: [1, 1, 1] }] });
    const short = buildScan({ walls: box(4, 3) });
    short.walls[0].transform = short.walls[0].transform.slice(0, 12);
    for (const raw of [null, {}, { walls: "x", objects: [] }, unknown, short])
      expect(() => capturedRoomToScenario(raw, keep)).toThrow("This scan file isn't in a format SpaceAble understands.");
  });
});
