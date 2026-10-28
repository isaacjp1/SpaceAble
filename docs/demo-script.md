# Three-minute demo script

Record the working app, not an animation. Timings were measured on
2026-10-26: Muse parse takes 4–7 s, Muse explain 11–17 s, SAM about 3 s for 2–3 concepts, and
Optimize under 0.1 s on the sample room. A run of Optimize at the 91.44 cm route width used in
step 3 found 3 verified alternatives.

**Before recording:** start both services and open `http://localhost:3000` (not 127.0.0.1).
Press **Reset sample**. Run one Muse request and one SAM detection to warm the connections,
then reset again. Check the header shows *Planner: online* and *Meta AI: configured*.

| Time | Show | Say |
| --- | --- | --- |
| 0:00–0:20 | Sample Bedroom. Press **Analyze**: the dresser is hatched red and the checks fail. | "Getting from the door to this desk takes an 80 cm clear path. Right now there isn't one, and moving furniture to find out is hard work." |
| 0:20–0:50 | **Photo (SAM 3.1)** → **Use sample photo** → **Detect with SAM 3.1** (bed, desk). Link *bed #1 → Bed*, *desk #1 → Desk*. | "Meta's SAM 3.1 outlines the furniture, parsed with Meta's official parser. It only labels the photo; measurements come from the person. We never guess sizes from a picture." |
| 0:50–1:15 | **Floor plan**. Type: *"I use a power wheelchair and need 36 inches of clear width to reach my desk. Leave the bed where it is. Can you check my doorway meets ADA?"* into **Ask or tell Muse** → **Send**. Point at the *Muse changed your room* banner (route width 91.44 cm, *bed* kept in place) and the ADA reference check in the steps. | "Muse Spark tells a request from a question. It converted inches, kept to real furniture, ran the ADA reference check instead of claiming compliance, and changed only what I asked. Undo puts it back." |
| 1:15–1:45 | **Analyze**. Point at the green area the route can reach, the red approach zone, and *measured vs required*. | "The pass/fail comes from geometry, not the AI: the person is modelled as a disc as wide as the route, against the furniture rectangles." |
| 1:45–2:25 | **Optimize** → card stats → **Preview** option 1 → **Side by side** → **Use this layout**. | "It searched placements cheapest-first and re-checked every option with the same validator. Before and after use the actual coordinates. Pushing the desk back 35 cm opens the route." |
| 2:25–2:45 | **Explain**: point at the badge *every number checked against the planner*. Flash **Print summary** (or show `docs/benchmark.md`: 21 rooms, 0 verification mismatches). | "Muse explains the result, but any number not in the planner's output gets the draft thrown away. Every alternative in our benchmark survived independent re-verification." |
| 2:45–3:00 | Footer disclaimer. | "This is a planning preview, not an accessibility certification. Check in person. Your space should adapt to you." |

**Architecture segment** (if the judges want one, about 15 s, during Optimize):
`docs/architecture.md` diagram. Next.js keeps the key server-side; FastAPI + Shapely make every
decision; Muse and SAM only propose and annotate.

## If something goes wrong live

- **Muse is slow:** keep talking over the loading state. If it fails, the error is shown
  honestly; set 91 cm by hand in *Your clearance needs* and carry on.
- **Explain falls back to the template:** show it. The label *Built-in explanation (no AI)* and
  the "discarded because…" note are the grounding check doing its job.
- **SAM finds an extra object** (it sometimes reports a low-confidence second "desk" by the
  window): leave it unlinked and say "that's why the person confirms every link."
- Record a full backup take before the final one.

## Before submitting

The hackathon rules require the video to show only work built during the hackathon period
(Oct 27 – Nov 4, 2026). Check the commit dates against the rules and say which parts were built when.
