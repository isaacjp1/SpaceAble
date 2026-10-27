# SpaceAble — Tasks

Boxes are ticked only after the relevant test or run has actually passed.

## Must-have features

- [x] 1. Measured 2D bedroom plan: grid, scale, furniture, door, dimensions
- [x] 2. Prebuilt failing scenario + editable room/furniture
- [x] 3. Add / select / drag / rotate / lock / delete furniture; no overlaps accepted
  (the editor allows overlaps but flags them; every optimizer alternative passes the collision check)
- [ ] 4. Door start, target zones, route width, optional turning diameter
  (all except picking among several doors: the UI edits one door, `start_door_id` exists in the schema)
- [x] 5. Deterministic `analyze` with structured evidence
- [x] 6. Deterministic `optimize` returning 1–3 validated alternatives (or honest no-solution)
- [x] 7. Muse Spark 1.3 text → editable constraints; evidence-grounded explanation
- [x] 8. SAM 3.1 photo masks/boxes with user association to plan objects
- [x] 9. Before/after, failed-check overlays, export JSON, printable summary
- [x] 10. Tests (geometry, routes, optimizer, API, e2e) + README with attribution

## Setup

- [x] Next.js/TS/Tailwind app + FastAPI service
- [x] `/health` endpoints, `.env.example`, test/lint commands
- [x] Shared schema + seed fixture, JSON roundtrip test (pytest + vitest)
- [x] UI shell rendering the sample room (Playwright)
- [x] Meta smoke script (Muse structured output + SAM on a local image via data URL); typechecks, refuses without a key
- [x] Smoke script executed against the live API (2026-10-26): Muse structured output OK; SAM found 2 beds + 1 desk in the CC0 sample photo

## Geometry validation

- [x] Furniture footprints, containment, collision (fixed obstacles = non-movable objects)
- [x] Door clear opening check + derived interior entry point
- [x] Destination approach rectangles
- [x] Clearance-aware free space + A* (no corner cutting, configurable grid)
- [x] Optional turning circle (with reachability)
- [x] `POST /v1/planner/analyze` with typed checks + tests (test matrix 1–13, 18)
- [x] UI editor: drag, numeric edits, rotation, Analyze, overlays (Playwright)

## Optimization

- [x] Candidate generator + static filter
- [x] Bounded best-first search (CP-SAT not used; same visit order as CP-SAT + no-good cuts, see architecture.md)
- [x] Every alternative re-validated by the same validator (test re-runs analyze on each returned layout)
- [x] Diverse ranked alternatives, budget + warnings reported
- [x] Performance + impossible-case tests (matrix 5, 14–17)
- [x] UI: Optimize + time limit, alternative cards, preview with before-outlines and arrows, use (Playwright)

## Meta AI features

- [x] Muse text → constraints (strict schema, Zod re-validation, review panel); live-verified
- [x] Muse explanation from validator evidence + grounding check + deterministic fallback; live-verified
- [x] SAM segmentation via `@meta-sam/parser`; live-verified
- [x] Photo overlay + object ↔ plan association UI (Playwright, mocked AI)
- [x] Mocked tests: missing key, 429, zero matches, bogus IDs, ungrounded explanations

## Product UX and evaluation

- [x] Alternatives, before/after side-by-side, route overlay, movement arrows (Playwright)
- [x] Keyboard controls, Help & limits dialog, disclaimer, inches display, cancel, mobile layout (plan first, no horizontal scroll at 390 px)
- [x] Save/load JSON (with selected alternative + explanation), print summary, browser autosave with restore (Playwright)
- [x] Synthetic benchmark (`docs/benchmark.md`): 21 rooms, 0 verification mismatches, reproducible; found + fixed an optimizer gap
- [x] Playwright flows (14 tests incl. building a room from scratch; AI routes mocked)

- [x] Demo script (`docs/demo-script.md`)

## Release

- [x] Clean README, screenshots (from a production build), license, tests
- [x] Planner shared secret, proxy rate limits, security headers, non-root container user (tests)
- [x] Local production rehearsal: non-editable planner install with secret + `next build && next start` (docs/deploy.md)
- [ ] Build the Docker image (needs Docker Desktop WSL integration)
- [ ] Deploy web + planner (needs hosting accounts) and verify `/api/health` + 401 on the bare planner
- [ ] Rotate the Meta key, then create the public GitHub repo and push
- [ ] ≤3-minute demo recording (`docs/demo-script.md`)
- [ ] Confirm hackathon rules on work dated before Oct 27
- [ ] Submit by Nov 4, 9:00 p.m. ET
