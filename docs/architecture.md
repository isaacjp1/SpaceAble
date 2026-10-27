# SpaceAble architecture

```text
browser (Next.js page, SVG floor-plan editor)
   │  RoomScenario JSON (cm), photo, free text
   ▼
Next.js API routes  (server-only MODEL_API_KEY)
   ├─ /api/health              → planner reachability + whether Meta is configured
   ├─ /api/planner/analyze     → FastAPI POST /v1/planner/analyze
   ├─ /api/planner/optimize    → FastAPI POST /v1/planner/optimize
   ├─ /api/ai/parse-request    → Muse Spark 1.3, json_schema output (proposal for review)
   ├─ /api/ai/explain          → Muse Spark 1.3, evidence-only, grounding-checked
   └─ /api/ai/segment          → SAM 3.1 + @meta-sam/parser (boxes + mask paths)
   ▼
FastAPI planner (Python 3.12, Pydantic v2, Shapely 2)
   models.py    contracts + cross-reference validation
   geometry.py  footprints, containment, collision, approach zones
   routing.py   free-center space, A*, smoothing, segment verification, turning circle
   analyze.py   builds the typed ValidationResult
   optimize.py  candidate placements + bounded best-first search, every result re-validated
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
| Door | start door only (`requirements.start_door_id`, default first door): `clear_width_cm ≥ door_min_clear_width_cm`, checked separately from route width |
| Required destinations | `requirements.required_destination_ids` is authoritative. `Destination.required` is a mirror the UI keeps in sync; the planner ignores it. Non-required destinations are still analysed and reported as optional |
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

## Optimizer

1. **Run analyze on the submitted layout** (the `baseline`). If it passes, the current
   layout is the only alternative returned: nothing is moved for the sake of it.
   Required `needs_input` checks give `needs_input`.
2. **Movers** are `movable` objects that are not in `locked_object_ids`. If there are none,
   the result is `discretized_search_infeasible` with a hint.
3. **Monotonicity pre-check.** Analyze the room with every mover (and its own
   destinations) removed. Removing furniture only enlarges free space, so a required check
   that still fails cannot be fixed by any placement of the movers. Examples are a door
   narrower than the minimum, or a turning circle larger than the room. The reply quotes the
   failing checks.
4. **Candidates per mover.** The list starts with "stay" (cost 0). Then come grid placements
   (`grid_spacing_cm`, default 20) plus wall-flush positions, at 0/90° (all four orientations
   when the object has a required approach zone, because its side turns with it). A placement
   is dropped if it overlaps fixed furniture or a fixed approach zone, sits on the entry disk,
   or puts its own approach zone outside the room, on fixed furniture, or on the entry disk.
   The last rule keeps a person using the zone from standing in the doorway. It is a
   proposal rule only; `analyze` does not check it. The list is sorted by
   cost and capped at 120 (`MAX_CANDIDATES_PER_OBJECT`, a module constant, not an API option).
5. **Search.** A heap over the product of the lists visits combinations in increasing total
   cost, moving at most 3 objects. Cheap rejections come first: movers overlapping each
   other or each other's approach zones, then a polygon check that the entry's free-space
   component touches every target. Neither can accept a layout; only `analyze` can. The
   search stops after `max_alternatives` diverse passes or at `time_limit_s`.
6. **Statuses.** The search is `exhaustive` only when it emptied the heap, hit no time limit,
   truncated no candidate list and had at most 3 movers. Only then can it report
   `discretized_search_infeasible`, worded as "among the grid placements tried". Otherwise
   it reports `no_solution_found_within_budget`. Results are deterministic whenever the
   search finishes before the time limit.

**CP-SAT is not used.** CP-SAT with no-good cuts over binary placement
variables visits collision-free combinations in increasing linear cost. The heap
enumeration visits them in the same order, with less code and no OR-Tools dependency.
The validator stays the authority either way.

Cost weights in `optimize.py` are initial engineering defaults, not accessibility science.
They only rank layouts that already passed:

| Term | Weight |
| --- | --- |
| each moved object | 100 |
| centre displacement | 0.2 per cm |
| orientation changed | 10 |
| moved piece touches no wall | 20 (a realism preference we added; never a requirement) |
| required route length | 0.05 per cm (after validation) |

Alternatives that move the same pieces to the same orientations within 60 cm of each other
count as near-duplicates and are dropped. `optimization_profile: max_clearance` is not
implemented yet; it returns a warning and ranks by minimal changes.

## Security and deployment

- The planner is server-to-server only. With `PLANNER_SHARED_SECRET` set (required in production), every
  route except `/health` needs the `x-planner-secret` header (constant-time comparison), which only the
  Next.js proxy sends.
- Next.js routes rate-limit per client IP and bucket: analyze 120/min, optimize 20/min, AI 20/min. Bodies are
  capped (planner 512 KB, AI JSON 64–128 KB, photos 5 MB) and timeouts are explicit.
- Every page sends `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` and
  `Permissions-Policy`, and no `X-Powered-By`. The planner container runs as a non-root user.
- See [`deploy.md`](deploy.md) for hosting, variables and the pre-publication checklist.

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

Live-verified 2026-10-26 with `npm run smoke:meta`:
- Muse: `chat.completions.create` with `response_format.json_schema` returned schema-valid JSON
  (`{"locked_object_ids":["bed"],"required_destination_ids":["desk-approach"],"route_width_cm":null}`).
  It used about 600 reasoning tokens for a short prompt, so expect noticeable latency.
- SAM: `responses.create({stream: true, metadata: {mask_encoding: "one_bit"}})` with a base64 JPEG
  data URL. The parser outcome was `completed` with 0 diagnostics. On the CC0 sample photo, "bed" gave
  2 matches and "desk" gave 1, and the box coordinates line up with the photo.

### In the product

| Route | What the model does | What stops it overreaching |
| --- | --- | --- |
| `parse-request` | Muse turns a sentence into `{locked_object_ids, required_destination_ids, route_width_cm, turning_diameter_cm, optimization_profile, clarifying_questions, unsupported_requests}` | The JSON schema has enums of the scenario's real IDs, and Zod re-validates the reply; unknown IDs are rejected (502, nothing applied). A width equal to the current value means "keep". A width when the text has no digits becomes a clarifying question instead of a value. The user edits and approves the proposal in a review form; nothing is applied automatically. The room title is never sent |
| `explain` | Muse writes 3–5 sentences from the planner's evidence (checks, moves, assumptions) | `checkExplanation` rejects any number not in the evidence (±0.5 tolerance; integers ≤ 3 allowed as counts) and any sentence with a compliance, certification, guarantee or safety claim without a negation. A rejected draft is replaced by the deterministic template, with the reason shown. With no key or an upstream error the template is returned too, always labelled "Built-in explanation (no AI)" |
| `segment` | SAM 3.1 segments 1–3 concepts, one request each, in parallel | The image type comes from its magic bytes (JPEG/PNG), at most 5 MB and 4096 px. The browser re-encodes the photo (max 1600 px), which drops EXIF/GPS. It is sent as a base64 data URL and never stored or logged. Detections only annotate the photo; the user links them to plan furniture, and "add as new" creates unmeasured (`confirmed: false`, `label_source: ai-inferred`) furniture |

Errors follow the contract: no key gives 503 `META_NOT_CONFIGURED`, upstream 429 gives 429 `META_RATE_LIMITED`
(retryable), and network, timeout or 5xx give `UPSTREAM_UNAVAILABLE`. There is also an in-memory limit of 20 AI
requests per minute per IP. Only error class names are logged, never prompts, photos or replies. Tests mock
Meta at the fetch layer; Playwright mocks `/api/ai/*`.

Live-verified 2026-10-26 through the app routes (`npm run dev`, real key):
- `parse-request`, "Keep my bed where it is, but make the route to my desk clearer." gave bed locked,
  desk-approach required, both widths null (keep current), no questions, in 3.9 s.
- `parse-request`, "…need 36 inches of clear width to reach my desk… leave the bed alone. Can you also check
  if my doorway meets ADA?" gave `route_width_cm: 91.44`, bed locked, and `unsupported_requests: ["check if
  doorway meets ADA"]`, in 6.6 s.
- `reasoning_effort: "low"` is accepted. It cut parse latency from 22 s to 4–7 s, and explain stayed grounded.
- `explain` on the canonical baseline vs option 1: four runs, all passed the grounding check (11–17 s).
- `segment` on the CC0 sample with bed, desk and lamp, in 2.6 s total. bed: 2 boxes (0.57, 0.75). desk: 1 (0.88).
  lamp: 2 (the wall sconces). All completed, with 0 dropped records. A later run also returned a
  low-confidence second "desk" at the window, which is why the user confirms links.

## Deliberate simplifications

- Axis-aligned rectangular room and furniture only.
- Door swing is not modelled.
- The approach zone is centred on its side (not slid along it).
- A grid miss in a passage narrower than about one grid cell above the threshold can
  produce a false "no route". It is never a false pass, because every returned
  segment is verified against the exact free-space polygon.
