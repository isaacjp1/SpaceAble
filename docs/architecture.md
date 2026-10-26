# SpaceAble architecture

```text
browser (Next.js page, SVG floor-plan editor)
   │  RoomScenario JSON (cm), photo, free text
   ▼
Next.js API routes  (server-only MODEL_API_KEY)
   ├─ /api/health              → planner reachability + whether Meta is configured
   ├─ /api/planner/analyze     → FastAPI POST /v1/planner/analyze
   ├─ /api/planner/optimize    → FastAPI POST /v1/planner/optimize
   ├─ /api/ai/parse-request    → Muse Spark 1.3, json_schema output
   ├─ /api/ai/explain          → Muse Spark 1.3, evidence-only
   └─ /api/ai/segment          → SAM 3.1 + @meta-sam/parser
   ▼
FastAPI planner (Python 3.12, Pydantic v2, Shapely 2)
   models.py    contracts + cross-reference validation
   geometry.py  footprints, containment, collision, approach zones
   routing.py   free-center space, A*, smoothing, segment verification, turning circle
   analyze.py   builds the typed ValidationResult
   main.py      HTTP + error contract
```

The planner is the only component that decides pass/fail. The models only
produce *proposals*: constraints the user reviews, and text that explains the
validator's numbers. The browser draws whatever geometry the planner returns.

## Coordinates and units

- Centimeters everywhere. Origin top-left, x right, y down.
- `(x_cm, y_cm)` is the top-left corner of the object's **current** footprint.
  `rotation_deg ∈ {0, 90, 180, 270}`; 90/270 swap width and height. Anything else
  is rejected (422), never rounded. The UI rotates about the footprint center and
  writes the new top-left back.
- A destination `side` (`top/right/bottom/left`) is relative to the object's
  unrotated frame and turns with it (90° clockwise: bottom → left).

## Geometry rules

| Rule | Implementation |
| --- | --- |
| Containment | footprint within room rectangle, ε = 1e-6 cm |
| Collision | interior overlap in both axes > ε; shared edges are allowed |
| Fixed obstacles | furniture with `movable: false` (no separate type) |
| Door | `clear_width_cm ≥ door_min_clear_width_cm`, checked separately from route width |
| Route start | door midpoint pushed inward by `r + 1 cm` (clamped along the wall). The route width threshold is never applied across the doorway. `entry_anchor` is informational only |
| Agent | disk of radius `r = route_width_cm / 2` (translation only, no kinematics) |
| Free centers | `room.buffer(-r) − union(footprints).buffer(r')`, where `r' = r / cos(π/4q)` so the polygonal arc approximation circumscribes the true disk (conservative) |
| Grid | nodes every `grid_cm` (default 5), aligned to the start point, 8-connected; diagonals only if both orthogonal neighbours are free (no corner cutting) |
| Grid edge safety | accepted if `d_i + d_j > L` (clearance distances to the free-space boundary; worst point clearance is `(d_i+d_j−L)/2`), otherwise only after an exact Shapely `covers` test |
| Path | A* to any free node inside the approach rectangle, then string-pull smoothing using `covers`, then every final segment is re-verified |
| Approach zone | rectangle `approach_width × approach_depth` centred on the chosen side; must lie in the room and overlap no furniture |
| Turning circle | free centers for radius `D/2`; pass only if such a center is in the same free-space component as the entry |

Statuses: `pass | fail | not_checked | needs_input | unknown`. Overall status:
any required `fail` → `fail`; else any `needs_input` → `needs_input`; else
`pass`. Missing route width / door widths → `needs_input`; missing turning
diameter → `not_checked`; any `confirmed: false` measurement → `needs_input`.

A failed route is reported as "no verified route under this approximation and
grid", never as physically impossible. If the exact polygon components say the
start and approach zone are connected but the grid found no path, a warning
suggests a finer grid. If the room itself is too small for the route width or
turning diameter, the message says so explicitly.

## Data contracts

Pydantic models in `services/planner/app/models.py` are authoritative. The
JSON Schema for `RoomScenario` is exported to `shared/schemas/` by a test.
The web app validates user-edited/imported scenarios with Zod
(`apps/web/lib/schema.ts`); response types are plain TS types.

## Meta integration (verified against docs 2026-10-26)

- Base URL `https://api.meta.ai/v1`, `Authorization: Bearer $MODEL_API_KEY`, via the
  `openai` SDK with an explicit `baseURL`/`apiKey` (it does not read `MODEL_API_KEY`).
- Muse Spark 1.3 (`muse-spark-1.3`): Chat Completions with
  `response_format: {type: "json_schema", json_schema: {...}}`. No recursive schemas.
- SAM 3.1 (`sam-3.1`): `POST /v1/responses`, one noun-phrase concept per request,
  `input_image.image_url` accepts a base64 data URL (so private photos are never
  published). Output is special-token text, parsed with `@meta-sam/parser`
  (`parseImageStream`, `recordsOfKind`, `decodeMaskToRaster`). Zero records is a
  valid "no matches".

## Deliberate simplifications

- Axis-aligned rectangular room and furniture only.
- Door swing is not modelled.
- The approach zone is centred on its side (not slid along it).
- A grid miss in a passage narrower than about one grid cell above the threshold can
  produce a false "no route". It is never a false pass, because every returned
  segment is verified against the exact free-space polygon.
