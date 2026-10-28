# SpaceAble

**Measured, verified furniture rearrangements for people who use a wheelchair or another mobility
device.** You enter your room and the clearance you need. Meta's models help you describe the
problem. A geometry engine, not an AI, decides whether a layout works.

> Planning preview based on confirmed dimensions and simplified 2D geometry. Not an
> accessibility certification or safety guarantee. Verify in person and seek
> professional assessment where needed.

![The sample bedroom fails: the dresser blocks the approach to the desk](docs/screenshots/1-analyze-fail.png)

## What it does

1. **Checks your room.** Furniture must fit inside the room without overlapping. The door must be wide enough.
   An 80 cm (or your own) route must exist from the door to each place you need to reach, plus an optional
   turning circle. Every result shows measured vs required values and the assumptions behind it.
2. **Finds rearrangements.** It searches discrete placements cheapest-first, moving at most three pieces,
   and offers the option with the fewest changes and the one with the widest route. Each option is re-checked by the same validator before you see it. When no option exists, it says why,
   and never says "impossible" just because it ran out of time. It can also find a place for a piece you
   don't own yet ("would a 100 × 40 cm bookshelf fit?"), moving other furniture only if needed.
3. **ADA reference check.** It compares the room with five dimensional rules of the 2010 ADA Standards:
   36 in routes (403.5.1), a 32 in door (404.2.3), a 60 in turning circle (304.3) and 30 × 48 in clear
   floor spaces (305.3), including both sides of a bed (806.2.3). The planner checks a copy of your room, so
   your own requirements stay as they are. It lists the ADA areas it doesn't check, notes where it is
   stricter than the ADA, and never says a room is compliant: it is a reference, not a compliance determination.
4. **Uses Meta's models where they help, and keeps them out of the verdict:**
   - **Muse Spark 1.3** explains results, but a draft quoting any number the planner didn't produce
     is replaced by a labelled template.
   - **SAM 3.1** outlines furniture in a room photo (parsed with Meta's official `@meta-sam/parser`). You
     link what it finds to your plan. Photo pixels are never turned into measurements.
   - **Muse Voice Transcribe** lets you say your request instead of typing it, for anyone who finds
     typing hard. Tap **Speak**, then tap again to stop (no press-and-hold). The words land in the text
     box for you to check and edit, and nothing goes to Muse Spark until you ask.
   - **Ask or tell Muse** is one box for questions and commands. Muse Spark decides which it is.
     A question (*"Would a 100 by 40 cm bookshelf fit?"*) runs the planner through `check_layout` and
     `find_layouts`, and each check becomes a what-if you can load, preview and leave. A command
     (*"Move the desk against the right wall"*, *"Keep the bed where it is, I need 36 inches"*) goes
     through `change_room`: it moves, turns, adds or removes furniture and sets your requirements,
     the planner checks the result, and you see it at once with **Undo**. It works over up to three
     rounds, with a progress bar for each step. Widths and furniture sizes must come from your own
     words; otherwise it asks. Every number in the answer is checked against the planner, and
     follow-up questions build on earlier results. Asked about the ADA, it runs the ADA reference
     check, and can search for rearrangements using the ADA dimensions.

| Muse proposes, you approve | Before / after, both verified | SAM outlines, you confirm |
| --- | --- | --- |
| ![Muse review panel](docs/screenshots/2-muse-review.png) | ![Side-by-side comparison](docs/screenshots/3-optimize-compare.png) | ![SAM detections on a photo](docs/screenshots/4-sam-photo.png) |

## Run it locally

Requires Python 3.11+ (3.12 tested) and Node 20.17+ (24 tested).

```bash
# Terminal 1: planner API
cd services/planner
python -m venv .venv && source .venv/bin/activate   # or: uv venv --python 3.12 .venv
pip install -e '.[dev]'
uvicorn app.main:app --reload --port 8000

# Terminal 2: web app
cp .env.example apps/web/.env.local                   # add MODEL_API_KEY for the AI features
cd apps/web
npm install
npm run dev                                           # open http://localhost:3000 (not 127.0.0.1)
```

Without a Meta key, everything except the AI features works. The header shows whether the planner is
online and whether a key is configured, never the key itself. **Help & limits** in the app walks through
the workflow. Deployment: [`docs/deploy.md`](docs/deploy.md).

## iPhone app

`apps/ios` is a native iPhone app for people who don't want the measurements. It has four screens:

1. **How do you get around?** Wheelchair, power chair or scooter, walker or rollator, crutches, or cane.
   You can also describe it in your own words (Muse Spark picks the closest option and the pieces you mention).
2. **Scan your room** with Apple's RoomPlan (an iPhone or iPad with a LiDAR scanner, iOS 17+).
   **Try a sample room** works on any phone.
3. **Does this look right?** The scanned plan. Tap a piece to mark it as one you need to reach, one that
   must stay put, or one that isn't really there. Tap a door to make it the way in. Then tap **Looks right**
   once to confirm.
4. **Your plan.** A headline such as "Move 1 thing and you can get from the door to the bed and the desk
   with a wheelchair", numbered steps ("Move the dresser against the wall with the door"), and the plan with
   arrows and the route. When there are two options you choose between "Fewest changes" and "Most space".
   The measurements are under **Details**.

The planner still decides every result. The app only turns "crutches" into numbers, using a fixed table of
planning defaults (`PROFILES` in `apps/web/lib/simple.ts`). They are not clinical advice:

| | Path width | Doorway | Turning circle | Space at each piece |
| --- | --- | --- | --- | --- |
| Wheelchair | 91.44 cm (36 in) | 81.28 cm (32 in) | 152.4 cm (60 in) | 30 × 48 in (ADA) |
| Power chair or scooter | 100 cm | 81.28 cm | 180 cm | 30 × 48 in |
| Walker or rollator | 90 cm | 81.28 cm | none | 80 × 90 cm |
| Crutches | 90 cm | 76 cm | none | 80 × 90 cm |
| Cane | 75 cm | 76 cm | none | 80 × 90 cm |

Places you need to reach start as the beds, tables, sofas, storage and fixtures such as the toilet. Each
one's space goes on the side with the most floor in front of it. A scan measures the door frame, which is
wider than the opening. If even that is too narrow, the app says so, asks you to measure it, and plans the
furniture anyway. Only rectangular rooms are supported.

The app talks to the web app's `/api/app/draft` and `/api/app/plan` routes, so the website (and the planner
behind it) must be deployed. The address is `https://spaceable.vercel.app` unless `SpaceAbleServer` in
`apps/ios/Info.plist` says otherwise; plain-http local addresses work for a dev server on your network.
The detailed website is unchanged and still opens a raw scan file with **Load JSON**.

The app builds on Linux or WSL with [xtool](https://github.com/xtool-org/xtool), no Mac needed:

```bash
xtool setup        # once: sign in with an Apple ID and point it at a downloaded Xcode .xip
cd apps/ios
xtool dev build    # compile only
xtool dev          # build, install and run on a connected iPhone
```

The first install needs Developer Mode on the phone and the developer certificate trusted under
Settings > General > VPN & Device Management. With a free Apple ID, the install expires after 7 days.

## How it decides

The person and device are modelled as a disc as wide as the route. Valid centre positions are the
room shrunk by that radius, minus every piece of furniture grown by it (the arcs are buffered so the
polygon always errs on the safe side). A grid A* search with no diagonal corner-cutting looks for a path
from just inside the door to the approach zone. Every segment is re-verified against the exact free
space, and the clearance is measured directly against the furniture rectangles. More detail, including
what is deliberately simplified, is in [`docs/architecture.md`](docs/architecture.md).

**Evidence:** [`docs/benchmark.md`](docs/benchmark.md) covers 21 synthetic rooms. Every reported layout was
re-analysed and independently re-checked: 0 mismatches, reproducible across runs. These are synthetic rooms
and say nothing about real homes.

## Tests

```bash
cd services/planner && pytest -q && ruff check .        # 73 tests: geometry, routes, optimizer, API, benchmark
cd services/planner && python -m app.benchmark --repeat --write ../../docs/benchmark.md
cd apps/web && npm run test && npm run lint && npm run typecheck   # 96 tests, Meta and the planner mocked at the fetch layer
cd apps/web && npx playwright install --with-deps chromium && npm run test:e2e   # 22 browser flows, AI routes mocked
cd apps/web && npm run smoke:meta -- path/to/consented-photo.jpg bed speech.wav   # REAL, billed Meta calls
```

## Layout

```text
apps/web/            Next.js 16 UI + API routes (planner proxy, Meta proxy; keys stay server-side)
apps/ios/            iPhone app (SwiftUI, built with xtool): LiDAR scan → how you get around → proposed rearrangement
services/planner/    FastAPI + Shapely geometry engine and optimizer (the only place pass/fail is decided)
shared/fixtures/     test rooms used by both sides, the tests and the benchmark
shared/schemas/      JSON Schema exported from the Pydantic models
docs/                architecture, benchmark, deployment, demo script, screenshots
```

## Limitations

- 2D, axis-aligned rectangles only. No heights, door swing, knee/toe clearance or wheelchair kinematics.
- Results are only as good as the measurements entered. Unconfirmed sizes block a verdict.
- Room scans: rectangular rooms only, and scanned door widths are the frame, not the clear opening.
- "No route" means none was found on a 5 cm grid, not that none exists.
- Not an ADA or building-code compliance check. The ADA reference check covers 5 dimensional rules only, and the
  ADA applies to public places such as hotels, not most private homes. No substitute for an occupational therapist.
- Rate limits live in memory per server instance.

## Privacy and security

Rooms stay in your browser unless you export them. Photos are resized in the browser (which drops EXIF/GPS),
sent to Meta only when you press Detect, and not stored or logged by SpaceAble. Voice recordings are
converted to WAV in the browser, sent to Meta only when you stop recording, and not stored or logged
either; your furniture names go with them as recognition hints. The iPhone app sends the scan
(room geometry and furniture boxes only, no camera images) to the web app to be converted; it is not stored
or logged. A raw scan opened with **Load JSON** on the website is converted in the browser. Meta's terms govern
processing on their side. The Meta key and the planner's shared secret are server-only. The planner rejects
any caller without the secret.

## Attribution

- Built with Meta's Model API: **Muse Spark 1.3**, **SAM 3.1** and **Muse Voice Transcribe** (https://dev.meta.ai). SAM output is parsed
  with Meta's [`@meta-sam/parser`](https://www.npmjs.com/package/@meta-sam/parser) (SAM License).
- Sample photo `apps/web/public/samples/hostel-twin-room.jpg`: "Twin room in a German youth hostel with single
  beds and wardrobe A" by Profpcde,
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Twin_room_in_a_German_youth_hostel_with_single_beds_and_wardrobe_A.jpg),
  CC0 1.0 (1280 px copy).
- Reference dimensions mentioned in the UI (e.g. a 60 in / 152.4 cm turning circle) come from the U.S. Access
  Board guides. They are editable references, not compliance checks.

## License

MIT (see `LICENSE`). Third-party packages keep their own licenses.
