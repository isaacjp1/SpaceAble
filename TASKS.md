# SpaceAble — Tasks

Boxes are ticked only after the relevant test or run has actually passed.

## Must-have features

- [x] 1. Measured 2D bedroom plan: grid, scale, furniture, door, dimensions
- [x] 2. Prebuilt failing scenario + editable room/furniture
- [ ] 3. Add / select / drag / rotate / lock / delete furniture; no overlaps accepted
  (editing done + e2e-tested; "accepted layouts" arrive with the optimizer)
- [ ] 4. Door start, target zones, route width, optional turning diameter
  (all except picking among several doors: the UI edits one door, `start_door_id` exists in the schema)
- [x] 5. Deterministic `analyze` with structured evidence
- [ ] 6. Deterministic `optimize` returning 1–3 validated alternatives (or honest no-solution)
- [ ] 7. Muse Spark 1.3 text → editable constraints; evidence-grounded explanation
- [ ] 8. SAM 3.1 photo masks/boxes with user association to plan objects
- [ ] 9. Before/after, failed-check overlays, export JSON, printable summary
- [ ] 10. Tests (geometry, routes, optimizer, API, e2e) + README with attribution

## Setup

- [x] Next.js/TS/Tailwind app + FastAPI service
- [x] `/health` endpoints, `.env.example`, test/lint commands
- [x] Shared schema + seed fixture, JSON roundtrip test (pytest + vitest)
- [x] UI shell rendering the sample room (Playwright)
- [x] Meta smoke script (Muse structured output + SAM on a local image via data URL); typechecks, refuses without a key
- [ ] **Smoke script executed against the live API — NOT DONE: no `MODEL_API_KEY` available yet**

## Geometry validation

- [x] Furniture footprints, containment, collision (fixed obstacles = non-movable objects)
- [x] Door clear opening check + derived interior entry point
- [x] Destination approach rectangles
- [x] Clearance-aware free space + A* (no corner cutting, configurable grid)
- [x] Optional turning circle (with reachability)
- [x] `POST /v1/planner/analyze` with typed checks + tests (test matrix 1–13, 18)
- [x] UI editor: drag, numeric edits, rotation, Analyze, overlays (Playwright)

## Optimization

- [ ] Candidate generator + static filter
- [ ] Bounded search / CP-SAT with no-good cuts
- [ ] Every alternative re-validated by the same validator
- [ ] Diverse ranked alternatives, budget + warnings reported
- [ ] Performance + impossible-case tests (matrix 5, 14–17)

## Meta AI features

- [ ] Muse text → constraints (strict schema, Zod re-validation, review panel)
- [ ] Muse explanation from validator evidence + deterministic fallback
- [ ] SAM segmentation via `@meta-sam/parser`
- [ ] Photo overlay + object ↔ plan association UI
- [ ] Mocked tests: missing key, 429, zero matches, bogus IDs

## Product UX and evaluation

- [ ] Alternatives, before/after, route overlay, movement arrows
- [ ] Keyboard controls, help, disclaimer, mobile fallback
- [ ] Save/load JSON, print view
- [ ] Synthetic benchmark (`docs/benchmark.md`)
- [ ] Playwright smoke flow

## Release

- [ ] Clean README, screenshots, license, tests
- [ ] Deploy, CORS, secrets
- [ ] ≤3-minute demo
- [ ] Submit by Nov 4, 9:00 p.m. ET
