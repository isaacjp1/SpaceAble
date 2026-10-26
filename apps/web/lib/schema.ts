// Client-side contract for user-edited / imported scenarios. Mirrors
// services/planner/app/models.py (authoritative; JSON Schema in shared/schemas/).
import { z } from "zod";

const MAX_CM = 3000;
const length = z.number().positive().max(MAX_CM);
const coord = z.number().min(0).max(MAX_CM);
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/);
const side = z.enum(["top", "right", "bottom", "left"]);

export const KINDS = [
  "bed", "desk", "dresser", "chair", "table", "wardrobe",
  "nightstand", "sofa", "shelf", "obstacle", "other",
] as const;

export const DoorSchema = z.strictObject({
  id,
  wall: side,
  offset_cm: coord,
  clear_width_cm: length.nullable().default(null),
  entry_anchor: z.strictObject({ x: z.number(), y: z.number() }).nullable().optional(),
  confirmed: z.boolean().default(false),
});

export const FurnitureSchema = z.strictObject({
  id,
  label: z.string().min(1).max(80),
  kind: z.enum(KINDS).default("other"),
  x_cm: coord,
  y_cm: coord,
  width_cm: length,
  height_cm: length,
  rotation_deg: z.literal([0, 90, 180, 270]).default(0),
  movable: z.boolean().default(true),
  confirmed: z.boolean().default(false),
  label_source: z.enum(["user-provided", "ai-inferred"]).default("user-provided"),
});

export const DestinationSchema = z.strictObject({
  id,
  object_id: id,
  side,
  approach_width_cm: length,
  approach_depth_cm: length,
  required: z.boolean().default(false),
});

export const RequirementsSchema = z.strictObject({
  route_width_cm: length.nullable().default(null),
  door_min_clear_width_cm: length.nullable().default(null),
  turning_diameter_cm: length.nullable().default(null),
  required_destination_ids: z.array(id).max(20).default([]),
  locked_object_ids: z.array(id).max(40).default([]),
  optimization_profile: z.enum(["minimal_changes", "max_clearance"]).default("minimal_changes"),
  start_door_id: id.nullable().default(null),
});

export const RoomScenarioSchema = z
  .strictObject({
    id,
    version: z.literal(1).default(1),
    units: z.literal("cm").default("cm"),
    title: z.string().max(120).nullable().optional(),
    room: z.strictObject({ width_cm: length, height_cm: length }),
    doors: z.array(DoorSchema).max(8).default([]),
    objects: z.array(FurnitureSchema).max(40).default([]),
    destinations: z.array(DestinationSchema).max(20).default([]),
    requirements: RequirementsSchema.default(RequirementsSchema.parse({})),
  })
  .superRefine((s, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const [name, items] of [["door", s.doors], ["object", s.objects],
      ["destination", s.destinations]] as const) {
      const ids = items.map((i) => i.id);
      const dupes = [...new Set(ids.filter((i, n) => ids.indexOf(i) !== n))];
      if (dupes.length) fail(`Duplicate ${name} id(s): ${dupes.join(", ")}`);
    }
    const objects = new Set(s.objects.map((o) => o.id));
    const dests = new Set(s.destinations.map((d) => d.id));
    for (const d of s.destinations)
      if (!objects.has(d.object_id)) fail(`Unknown destination '${d.id}' object id '${d.object_id}'`);
    for (const i of s.requirements.locked_object_ids)
      if (!objects.has(i)) fail(`Unknown locked object id '${i}'`);
    for (const i of s.requirements.required_destination_ids)
      if (!dests.has(i)) fail(`Unknown required destination id '${i}'`);
    const start = s.requirements.start_door_id;
    if (start && !s.doors.some((d) => d.id === start)) fail(`Unknown start door id '${start}'`);
    for (const d of s.doors) {
      const wall = d.wall === "left" || d.wall === "right" ? s.room.height_cm : s.room.width_cm;
      if (d.offset_cm + (d.clear_width_cm ?? 0) > wall + 1e-6)
        fail(`Door '${d.id}' extends beyond the ${d.wall} wall (${wall} cm)`);
    }
  });

export type RoomScenario = z.infer<typeof RoomScenarioSchema>;
export type Furniture = z.infer<typeof FurnitureSchema>;
export type Door = z.infer<typeof DoorSchema>;
export type Destination = z.infer<typeof DestinationSchema>;
export type Requirements = z.infer<typeof RequirementsSchema>;
export type Side = z.infer<typeof side>;

export const LayoutSchema = z.strictObject({
  object_positions: z.array(z.strictObject({
    object_id: id, x_cm: coord, y_cm: coord, rotation_deg: z.literal([0, 90, 180, 270]),
  })).max(40),
});
export type Layout = z.infer<typeof LayoutSchema>;

// ---- planner responses (produced by the backend; types only) ----

export type Status = "pass" | "fail" | "not_checked" | "needs_input" | "unknown";
export type XY = [number, number];

export interface Check {
  id: string;
  status: Status;
  required: boolean;
  measured_cm: number | null;
  required_cm: number | null;
  message: string;
  object_ids: string[];
}

export interface RouteEvidence {
  destination_id: string;
  door_id: string | null;
  status: Status;
  start: XY | null;
  target_rect: [number, number, number, number] | null;
  polyline: XY[];
  length_cm: number | null;
  min_clearance_cm: number | null;
}

export interface ValidationResult {
  status: Status;
  checks: Check[];
  routes: RouteEvidence[];
  turning_zones: { center: XY; diameter_cm: number; reachable: boolean }[];
  reachable_area: XY[][][];
  assumptions: string[];
  warnings: string[];
  grid_cm: number;
  elapsed_ms: number;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown; retryable: boolean };
}

export interface Move {
  object_id: string;
  from_x_cm: number;
  from_y_cm: number;
  from_rotation_deg: number;
  to_x_cm: number;
  to_y_cm: number;
  to_rotation_deg: number;
  distance_cm: number;
}

export interface Alternative {
  id: string;
  layout: Layout;
  moves: Move[];
  validation: ValidationResult;
  cost: { moved_objects: number; displacement_cm: number; route_length_cm: number; total_score: number };
}

export type OptimizeStatus =
  | "solutions_found" | "no_solution_found_within_budget" | "discretized_search_infeasible"
  | "needs_input" | "error";

export interface OptimizationResult {
  status: OptimizeStatus;
  message: string;
  alternatives: Alternative[];
  baseline: ValidationResult;
  search: {
    grid_spacing_cm: number; time_limit_s: number; elapsed_s: number;
    combinations_considered: number; candidates_tested: number; exhaustive: boolean;
  };
  warnings: string[];
}
