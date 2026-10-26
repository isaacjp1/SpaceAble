# SpaceAble

SpaceAble helps people who use a wheelchair or another mobility device explore
measured furniture rearrangements for their own room, using clearance needs
they set themselves. A deterministic geometry engine checks every layout. The
planned Meta AI features (Muse Spark 1.3, SAM 3.1) turn plain-language requests
into editable constraints and help identify furniture in a photo. They never
decide pass/fail.

> Planning preview based on confirmed dimensions and simplified 2D geometry. Not an
> accessibility certification or safety guarantee. Verify in person and seek
> professional assessment where needed.

## Status

Progress is tracked in `TASKS.md`.

| Works now | Not yet |
| --- | --- |
| 2D measured room editor (drag, arrow keys, numeric fields, rotate, lock, add/delete) | Optimizer |
| Planner `analyze`: containment, collisions, door width, approach zones, clearance-aware routes, turning circle | Muse/SAM in the UI |
| Verified route overlay, reachable area, failed-object highlighting, stale-result warning | Before/after, print view, benchmark |
| Save/load JSON, sample-room reset | Deployment |
| Meta smoke script (`npm run smoke:meta`) | Live Meta calls have **not** been run yet (no key configured) |

## Run locally

Requires Python 3.11+ (3.12 tested) and Node 20.17+ (24 tested).

```bash
# Terminal 1: planner API
cd services/planner
python -m venv .venv && source .venv/bin/activate   # or: uv venv --python 3.12 .venv
pip install -e '.[dev]'
uvicorn app.main:app --reload --port 8000

# Terminal 2: web app
cp .env.example apps/web/.env.local                   # add MODEL_API_KEY for AI features
cd apps/web
npm install
npm run dev                                           # http://localhost:3000
```

Manual planning works without a Meta key. The header shows whether the planner is
online and whether a key is configured. It never shows the key itself.

## Tests

```bash
cd services/planner && pytest -q && ruff check .        # geometry, routing, API contract
cd apps/web && npm run test && npm run lint && npm run typecheck
cd apps/web && npx playwright install --with-deps chromium && npm run test:e2e   # browser flow, uses both services
cd apps/web && npm run smoke:meta -- path/to/consented-photo.jpg bed  # REAL, billed Meta calls
```

## How the check works

The person and their device are modelled as a disk as wide as the configured route.
Valid centre positions are the room shrunk by that radius, minus every piece of
furniture grown by it. A grid A* search (no diagonal corner-cutting) looks for a
path from just inside the door to the destination's approach rectangle. Every
returned segment is re-verified against the exact free-space polygon. The path's
clearance is then measured directly against the original furniture rectangles. A
route is only reported when it passes both checks. Details and deliberate
simplifications are in [`docs/architecture.md`](docs/architecture.md).

## Layout

```text
apps/web/            Next.js 16 UI + API routes (planner proxy; Meta proxy)
services/planner/    FastAPI + Shapely geometry engine (authoritative pass/fail)
shared/fixtures/     scenario JSON used by both sides and by the tests
shared/schemas/      JSON Schema exported from the Pydantic models
docs/                architecture and assumptions
```

## Attribution

- Uses Meta's Model API: Muse Spark 1.3 and SAM 3.1 (https://dev.meta.ai). SAM output
  is parsed with Meta's [`@meta-sam/parser`](https://www.npmjs.com/package/@meta-sam/parser)
  (SAM License).
- Reference dimensions mentioned in the UI (e.g. a 60 in / 152.4 cm turning circle) come
  from the U.S. Access Board guides. They are user-editable references, not compliance checks.

## License

MIT (see `LICENSE`). Third-party packages keep their own licenses.
