import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RoomScenarioSchema } from "@/lib/schema";

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(__dirname, "../../../shared/fixtures", `${name}.json`), "utf8"));

describe("RoomScenarioSchema", () => {
  it.each(["canonical-bedroom", "feasible-bedroom"])("round-trips %s", (name) => {
    const parsed = RoomScenarioSchema.parse(fixture(name));
    expect(RoomScenarioSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(parsed.objects.map((o) => o.id)).toEqual(["bed", "desk", "dresser"]);
  });

  const bad: [string, (d: any) => void, string][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ["45° rotation", (d) => (d.objects[0].rotation_deg = 45), "rotation_deg"],
    ["infinite width", (d) => (d.objects[0].width_cm = Infinity), "width_cm"],
    ["negative x", (d) => (d.objects[0].x_cm = -1), "x_cm"],
    ["duplicate id", (d) => (d.objects[1].id = "bed"), "Duplicate object id"],
    ["unknown destination object", (d) => (d.destinations[0].object_id = "sofa"), "Unknown destination"],
    ["unknown locked id", (d) => (d.requirements.locked_object_ids = ["ghost"]), "Unknown locked"],
    ["door past wall", (d) => (d.doors[0].offset_cm = 300), "extends beyond"],
    ["extra field", (d) => (d.objects[0].colour = "red"), "colour"],
  ];
  it.each(bad)("rejects %s", (_, mutate, fragment) => {
    const d = fixture("canonical-bedroom");
    mutate(d);
    const r = RoomScenarioSchema.safeParse(d);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(fragment);
  });
});
