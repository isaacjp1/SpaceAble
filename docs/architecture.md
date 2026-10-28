# SpaceAble architecture

```text
iPhone app (apps/ios: SwiftUI + RoomPlan scanner)            browser (Next.js page, SVG floor-plan editor)
   │  raw CapturedRoom JSON, mobility aid, checked choices   │
   ▼                                                         │  RoomScenario JSON (cm), photo, free text
Next.js API routes  (server-only MODEL_API_KEY)  ◄───────────┘
   ├─ /api/app/draft           → lib/roomplan.ts: scan → draft room, default places to reach, way in
   ├─ /api/app/plan            → lib/simple.ts profile → optimize → plain-language result (Muse reads free text)
   ├─ /api/health              → planner reachability + whether Meta is configured
   ├─ /api/planner/analyze     → FastAPI POST /v1/planner/analyze
   ├─ /api/planner/optimize    → FastAPI POST /v1/planner/optimize
   ├─ /api/ai/explain          → Muse Spark 1.3, evidence-only, grounding-checked
   ├─ /api/ai/segment          → SAM 3.1 + @meta-sam/parser (boxes + mask paths)
   ├─ /api/ai/transcribe       → Muse Voice Transcribe (WAV recording → text for review)
   └─ /api/ai/assistant        → Muse Spark with planner tools (calls analyze/optimize server-side;
                                  answers questions, carries out commands with change_room;
                                  streams progress as newline-delimited JSON)
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
count as near-duplicates and are dropped.

**Widest route.** Every passing result reports `widest_route_cm` (on `ValidationResult`): the
widest route, in 1 cm steps above the required width, at which `analyze` still passes the
layout. The analyze endpoint fills it for a passing layout, and the optimizer fills it for a
passing baseline and every returned option. `analyze()` itself leaves it null, so the search
loop stays fast; that is also why re-analysis comparisons ignore the field. A polygon test (the
entry's free-space component, rebuilt for each width, touches every required approach zone)
finds the bound by bisection. `analyze` must then pass at that width, or the value is lowered
until it does. The route's `min_clearance_cm` can't serve here: the shortest path hugs the
furniture, so it is always about half the required width. The padding that keeps free space
conservative also makes this value slightly low (a 100 cm gap reports 99 cm).

**Two options, one per goal.** Optimize returns the layout with the fewest changes and the
layout with the widest route, each tagged in `best_for` (one option tagged with both when the
same layout wins). The search keeps going until 12 verified, diverse layouts are found (`POOL`)
or the time limit is hit. The cheapest by cost is the fewest-changes option; the widest, with
ties broken by cost, is the widest-route option. The pool is collected in cost order, so this
is the widest of the cheapest layouts, not the widest possible one. If the current layout
already passes, it is the fewest-changes option, and the search keeps only layouts with a wider
route than it. `optimization_profile` is still accepted in saved rooms but no longer used.

The search stops early when it can't get wider. No layout can beat the best spot for the most
constraining mover, measured with the polygon test with only the fixed pieces and that mover
in the room (every other piece only narrows the route), so once the widest found reaches that
ceiling, and at least 3 layouts were verified for the fewest-changes option, it stops. When the
current layout passes, a combination is only analysed if the polygon test says it could be
wider, and the search gives up after 12 such layouts in a row turn out not to be: the polygon
test can be a few cm more generous than `analyze`, and that gap can't be closed cheaply. A
layout's widest route is measured only if it could be the widest so far. Every combination is
checked at one width, so each footprint is grown for it once instead of per combination (the
merged polygons match `free_space` to within 1e-12 cm²). On the benchmark rooms this cut the
total search time from 55 s to 30 s with the same options; rooms whose wider layouts are rare
still use the whole time limit.

**New pieces (`to_place`).** A piece the person doesn't own yet carries `to_place: true`, and
its position is ignored. `analyze` leaves it out, along with its approach zones, and reports it
in an optional "Still to place" check.

`optimize` must place it in every option:
- Its candidate list has no "stay". A placement costs only the off-wall preference: no move
  penalty and no displacement. So existing pieces move only when the layout needs it.
- Placing it doesn't count towards the three moved pieces.
- Its move says `placed: true`, with distance 0.
- `apply_layout` clears the flag, so the independent re-check includes the placed piece.
- A room that already passes still searches when something needs placing.
- A piece with no legal spot is reported as "No spot for the new X".
- An unplaced piece can't be fixed or locked (422).

## ADA reference check

`lib/ada.ts` builds a copy of the room with the dimensional values of the 2010 ADA Standards (verified
against the U.S. Access Board text, 2026-10-27), and the planner's ordinary `analyze` checks that copy.
The person's own requirements are not changed. Each rule maps onto existing checks:

| Rule | Value used | Checked by | Where it differs from the ADA |
| --- | --- | --- | --- |
| 404.2.3 door clear width | 32 in (81.28 cm) | `door-clearance` | none (measure with the door open 90°) |
| 403.5.1 route clear width | 36 in (91.44 cm) | route checks to the places the person needs to reach | stricter: the 32 in allowance for stretches up to 24 in long isn't modelled |
| 304.3 turning space | 60 in (152.4 cm) circle | `turning-space` | stricter: the T-shaped space isn't modelled |
| 305.3 clear floor space | 30 × 48 in (76.2 × 121.92 cm) | approach zones: forward (30 in wide, 48 in deep) at desks and tables, side-on (48 in along) elsewhere | none |
| 806.2.3 both sides of a bed | 30 × 48 in, side-on | added zones `ada-<bed>-<side>` on both long sides, with their routes | a hotel guest-room rule; the panel says so |

A rule with nothing to check (no door, no bed, no places marked) is "not checked". The panel also
lists 10 ADA areas a 2D plan can't check: door maneuvering clearance, floor surfaces, changes in
level, door hardware and force, protruding objects, reach ranges, knee and toe clearance, operable
parts, storage, and toilet and bathing rooms. It never reports compliance, and its note says the ADA
covers public places such as hotels, not most private homes.

**Show on the plan** opens the ADA copy through the same what-if banner as the assistant, so
**Back to my room** restores the person's room and the report stays current.

In the assistant, `ada_reference_check` runs the same check. `use_ada_values` on `check_layout` and
`find_layouts` applies a what-if to the ADA copy, so a search for "what would fix this" uses the
ADA dimensions instead of the person's own. The number check accepts sentences that name the ADA
as the reference check ("passes 1 of the 5 ADA reference rules"). It still rejects "meets the ADA",
"complies" and any other ADA sentence without "reference", unless the sentence is negated.

Live-verified 2026-10-27 on the sample bedroom (real Muse and planner):
- **The panel:** 1 of 5 rules pass. The 90 cm door passes. These fail: the 91.44 cm route to the
  desk, the 152.4 cm turning circle, the desk's clear floor space (it overlaps the dresser), and
  both sides of the bed (left overlaps the dresser; right extends past a wall).
- **"Does my room meet ADA?"** (4.1 s): ran the check and said "passed 1 of 5 rules and failed 4 …
  This is not a compliance determination", naming each failure.
- **"What could I move to fix the clear floor space at my desk?"** (13.8 s): a first run, without
  `use_ada_values`, searched with the person's 80 cm needs and implied it fixed the ADA failure;
  that is why the flag and the prompt rule exist. With them, Muse searched with the ADA values,
  relayed the planner's finding that moving furniture can't fix every rule (the bed's right side is
  against a wall), and then checked a what-if with the dresser moved. That what-if clears the desk's
  30 × 48 in space, with a verified 93.4 cm route.

## Room scan

The iPhone app (`apps/ios`) is a thin SwiftUI client. When the person chooses **Use this scan**, it encodes
`CapturedRoom` with `JSONEncoder` and posts it to `/api/app/draft`. That route converts the scan and adds
the default places to reach (`defaultReach`) and the widest door as the way in (`defaultDoor`). It refuses
a scan it can't use, or one with no door, with a message to scan again. The app keeps the returned room as
opaque JSON and sends it back unchanged to `/api/app/plan`, together with the profile and the person's
taps (`reach`, `keep`, `remove`, `start_door_id`). Every id is checked before anything else runs.
`planScenario` in `lib/simple.ts` then:
- confirms every piece and door (the **Looks right** tap is the confirmation)
- applies the profile's widths
- adds one required zone per piece to reach, on the side with the most floor in front of it

The optimize result is turned into plain words by `summarize`. When the start door fails, the room is
optimized again with the door taken as it is, and the headline asks for a tape measure. Muse only maps free
text onto a profile key and piece ids; every number comes from the profile table or the planner. The
website's **Load JSON** accepts the same raw scan and converts it in the browser.

`capturedRoomToScenario` in `lib/roomplan.ts` turns the scan into a draft:
- **Floor plane.** ARKit world space is metres, y up. Each element's centre is the transform's
  translation `(x, z)` and its direction is its local x axis projected on the floor. Seen from above, +z
  points down the screen, so plan `(x, y)` = world `(x, z)` with no mirroring.
- **Squaring up.** The dominant wall direction, `atan2(Σ L·sin 4φ, Σ L·cos 4φ) / 4` weighted by wall
  length, becomes the x axis. The bounding box of the wall ends gives the room, rounded **down** to whole cm.
- **Rectangles only.** A curved wall, a wall more than 5° off square, or a wall more than 10 cm from every
  side of the box (an L-shaped room's inner walls) is rejected with a message. A box drawn around an
  L-shaped room includes floor that isn't part of it, so a route could "pass" through a wall.
- **Doors** and doorless openings go on the nearest side, centred where scanned and clamped to the wall;
  windows are ignored. At most 8. RoomPlan measures the door **frame**, which is wider than the gap a
  wheelchair actually passes through, so the width is optimistic. Doors therefore stay unconfirmed, and
  the review banner asks for a tape measure.
- **Furniture** boxes are "sized to the object's extremities", so sizes round **up**. Rotation snaps to
  the nearest quarter turn, with a warning past 10°. Pieces are clamped inside the walls (scan noise
  pushes them a few cm in), with a warning past 15 cm. Pieces larger than the room are left out, and
  beyond 40 the smallest are. Overlaps stay; the editor flags them.
- **Categories.** RoomPlan's 16 object categories map to bed, table (RoomPlan has no desk), chair and
  sofa, `wardrobe` for storage, or `other` for televisions. Bathtubs, toilets, sinks, kitchen appliances, washer/dryers,
  fireplaces and stairs become fixed obstacles (`movable: false`).
- **Everything is unconfirmed** (`confirmed: false`, `label_source: "ai-inferred"`), so **Analyze** returns
  `needs_input` until the person checks each item. Room width and depth can't be marked unconfirmed,
  so the review banner asks for them to be checked too. There are no destinations yet. The person's route,
  door and turning widths and the optimization profile carry over; locks, required destinations and the
  start door reset, because the old ids are gone.

**Privacy.** The app's raw scan (geometry and furniture boxes, no camera images) is converted by
`/api/app/draft` and is not stored or logged. A scan loaded on the website stays in the browser. Only the
converted `RoomScenario` reaches the planner, as with any room.

**Unconfirmed encoding.** Until a real scan has been read, `readScan` holds every assumption about the JSON
form of `CapturedRoom`: a column-major 4×4 `transform` (16 numbers, or 4 columns of 4) with the translation at
12–14, `dimensions` as `[x, y, z]` in metres with a wall's length first, and `category` as `{"bed": {}}`.
Anything else is refused as an unknown format rather than guessed. Debug builds of the app have a
**Share raw scan** button to take a real scan off the phone.

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
- Muse Spark tool calling: Chat Completions `tools` (`type: "function"`, `strict` optional).
  `tool_choice` accepts only `"auto"`. The full assistant message, including `tool_calls`, must be
  sent back before the `role: "tool"` results.
- Muse Voice Transcribe (`muse-voice-transcribe-1.0`): `POST /v1/asr/transcribe`, multipart with a JSON
  `request` part (`mode`, `model`, `audioEncoding`, `keywords`) and an `audio` part. Only RIFF/WAVE,
  mono 16-bit PCM at 16 or 24 kHz; at most 10 minutes and 32 MB.

Live-verified 2026-10-26 with `npm run smoke:meta`:
- Muse: `chat.completions.create` with `response_format.json_schema` returned schema-valid JSON
  (`{"locked_object_ids":["bed"],"required_destination_ids":["desk-approach"],"route_width_cm":null}`).
  It used about 600 reasoning tokens for a short prompt, so expect noticeable latency.
- SAM: `responses.create({stream: true, metadata: {mask_encoding: "one_bit"}})` with a base64 JPEG
  data URL. The parser outcome was `completed` with 0 diagnostics. On the CC0 sample photo, "bed" gave
  2 matches and "desk" gave 1, and the box coordinates line up with the photo.

Live-verified 2026-10-27 with `npm run smoke:meta -- speech.wav`:
- Tool calling: with two strict function tools, Muse made both calls in parallel in one turn
  (`check_layout({"route_width_cm":91.0})`, `find_layouts({"locked_object_ids":["bed"]})`), then
  answered from the canned results in a second turn. About 1.5 s per turn at `reasoning_effort: "low"`.
  The assistant message carries no reasoning field, so nothing beyond the message itself is replayed.
  Unprompted, the answer used markdown and quoted raw IDs.
- Transcribe: a 4.2 s, 16 kHz mono WAV (three spoken words) returned 200 in 1.4 s with
  `{"sessionId", "transcript": "wheelchair. desk. furniture.", "audioDurationMs": 4160, "turns": []}`.
  `turns` is empty in `PUSH_TO_TALK` mode.

Live-verified 2026-10-27 in the running app (real planner and Muse, no mocks), sample bedroom with
"most open space": Explain on the previewed option said the widest verified route is 163 cm against
the 80 cm needed, named it option 1 of 2 ranked by widest route, and quoted the search totals. On the
unmoved layout it said 2 options could be previewed. Both drafts passed the grounding check.

Live-verified 2026-10-27 in the running app: Chromium's fake microphone played a 6.8 s WAV of four
spoken words. After **Speak**, 7 s of recording and **Stop**, the text box read "Keep bed desk
wheelchair" about 2 s later (browser conversion plus Meta). **Turn into requirements** then returned
a Muse proposal in 4.5 s. It kept the current widths and asked what route width the wheelchair needs.

Live-verified 2026-10-27, assistant tool calling (spike):
- Strict tools accepted nullable fields.
- After a tool returned `{"error": "...not stated... ask them"}`, Muse asked the person instead of
  guessing.
- A final call **without** `tools`, after tool history, returned plain text. That is how a chain is
  ended.
- Strict mode did **not** stop malformed arguments: Muse sent a string for an `anyOf: [array, null]`
  field, and the string `"null"` for an optional enum. The tool schema now uses
  `type: [t, "null"]`; the server accepts `""` and `"null"` as "keep current"; and validation
  errors quote the received value, so Muse can correct itself in the next round.

Live-verified 2026-10-27, assistant in the running app (sample bedroom, real Muse and planner).
This is the final run, with all the fixes below. The progress bar advanced as events streamed,
e.g. 0/2 → 2/4 → 3/5 → 4/6.

| Question | Time | What happened |
| --- | --- | --- |
| "Keep the dresser where it is too. I need 36 inches to reach my desk." | 5.3 s | `check_layout` (91.44 cm, bed and dresser kept) fails, then `find_layouts` finds 2 options. The answer gives both: desk moved 35.4 cm, or 65.2 cm and turned 180°, each with a 99.44 cm widest route |
| Follow-up: "What about the second option, how wide is its route?" | 6.9 s | Re-ran the search, then answered "99.44 cm", naming option 2's moves |
| "Would a 100 by 40 cm bookshelf fit somewhere? I need to reach it from the front." | 8.2 s | Four calls in one round: two checks at a spot Muse chose (both fail) and two `find_layouts` (front = top or bottom side). The planner placed the new bookshelf both times; the answer quotes the spot (0, 220) and the 99 cm widest route |
| "Would a wider route fit?" | 6.5 s | No invented width: searched with `max_clearance` and reported 163 cm |
| "Can I keep both the desk and the dresser where they are? If not, what is the smallest change?" | 5.7 s | The room as it is fails; the smallest verified change moves the desk 35.4 cm |
| "Does my room meet ADA?" | 2.2 s | Declined in one sentence, with no tool call; labelled "No planner check was run" |

**Planner calls run one at a time.** In an earlier run of the bookshelf question, three searches
ran in parallel and each hit the 5 s limit without trying a single combination. Reproduced
directly: one search alone took 0.7 s, and three concurrent ones thrashed on the planner process's
GIL. Running them in sequence took that question from 17.4 s to 8.2 s.

The first live runs forced three prompt changes:
- **Convert units yourself.** Once, Muse asked for a width "in cm" despite "36 inches".
- **Keep the room's widths unless new ones are stated.** The new-measurement rule had made Muse
  ask for a route width the room already had.
- **Try ambiguous options in parallel.** For example, which side is a piece's front.

It was also told not to guess why the planner moved a piece. The number check confirms that each
quoted number exists in the evidence, not which option it belongs to. In the run where that
looked doubtful, both options did share 99.44 cm.

### In the product

| Route | What the model does | What stops it overreaching |
| --- | --- | --- |
| `explain` | Muse writes 3–6 sentences from the planner's evidence: checks before and after, moves, the widest verified route, the option's rank and how options were ranked, furniture kept in place or fixed, the search outcome (including why it found nothing), planner warnings and assumptions | `checkExplanation` rejects any number not in the evidence (±0.5 tolerance; integers ≤ 3 allowed as counts) and any sentence with a compliance, certification, guarantee or safety claim without a negation. A rejected draft is replaced by the deterministic template, with the reason shown. With no key or an upstream error the template is returned too, always labelled "Built-in explanation (no AI)" |
| `segment` | SAM 3.1 segments 1–3 concepts, one request each, in parallel | The image type comes from its magic bytes (JPEG/PNG), at most 5 MB and 4096 px. The browser re-encodes the photo (max 1600 px), which drops EXIF/GPS. It is sent as a base64 data URL and never stored or logged. Detections only annotate the photo; the user links them to plan furniture, and "add as new" creates unmeasured (`confirmed: false`, `label_source: ai-inferred`) furniture |
| `transcribe` | Muse Voice Transcribe turns a spoken request into text (`PUSH_TO_TALK`), with the room's furniture names as recognition keywords | The browser records with `MediaRecorder`, then decodes and resamples to 16 kHz mono 16-bit WAV (`OfflineAudioContext`, capped at 60 s), because the API takes only WAV. The server checks the file's own RIFF chunks (PCM, mono, 16-bit, 16 or 24 kHz, at most 60 s) before calling Meta, and filters keywords to short names (at most 20). The transcript only fills the text box: the person reviews or edits it and decides whether to send it to Muse Spark. Tap to start and tap to stop, no press-and-hold. Audio is held in memory for the request only, never stored or logged. The page's `Permissions-Policy` allows the microphone for this site only |
| `assistant` | Muse Spark decides whether the person is asking or telling. It answers questions by calling `check_layout` (analyze) and `find_layouts` (optimize) on what-if copies of the room, and carries out commands with `change_room`, which takes the same changes as `check_layout` and makes them to the room itself (later calls start from the changed room). The changes: new widths, locked pieces, places to reach, removals, moves, and new furniture (placed by the planner in `find_layouts`). Muse can ask for several calls at once (run one after another), over up to 3 rounds; the last call offers no tools, so Muse must answer. Progress, each planner run and the answer stream to the browser as newline-delimited JSON | Tool inputs are strict schemas with the room's real ids, re-validated with Zod. A wrong id or malformed input goes back to Muse as a tool error. A route width, turning circle or new-piece size must match a number the person wrote (with inch, foot, metre and millimetre conversions); otherwise the tool tells Muse to ask. At most 4 calls a round, 8 planner runs a question, `find_layouts` limited to 5 s, a 100 s deadline, and 6 questions a minute per IP. The answer goes through the same number check as Explain, against the room, this question's runs, earlier runs on the same room, and the person's numbers; a failing answer is replaced by a planner-only summary, and the runs stay. An answer with no planner run is labelled so. A question changes nothing until the person loads a what-if, which they can leave with **Back to my room**; autosave pauses while one is loaded. A command's changed room is applied when the answer arrives, with **Undo**, unless the room was edited meanwhile or a what-if is on screen: then it is offered as a what-if instead. `change_room` can't switch to the ADA copy of the room. A change counts only once the planner has checked it: if that check fails, Muse is told the room was not changed, and the calls planned on top of it in that round are not run |

Errors follow the contract: no key gives 503 `META_NOT_CONFIGURED`, upstream 429 gives 429 `META_RATE_LIMITED`
(retryable), and network, timeout or 5xx give `UPSTREAM_UNAVAILABLE`. There is also an in-memory limit of 20 AI
requests per minute per IP. Only error class names are logged, never prompts, photos or replies. Tests mock
Meta at the fetch layer; Playwright mocks `/api/ai/*`.

Live-verified 2026-10-26 through the app routes (`npm run dev`, real key). `parse-request` was later
folded into the assistant's `change_room`:
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
- Room scans: rectangular rooms only; doors snap to the nearest wall and furniture to quarter turns.
- Door swing is not modelled.
- The approach zone is centred on its side (not slid along it).
- A grid miss in a passage narrower than about one grid cell above the threshold can
  produce a false "no route". It is never a false pass, because every returned
  segment is verified against the exact free-space polygon.
