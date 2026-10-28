// The assistant's UI with /api/ai/assistant mocked. The mocked stream carries a real planner search
// (run through the app's planner proxy), so the what-if, its options and the placed shelf are genuine.
import { expect, test } from "@playwright/test";
import fixture from "../../../shared/fixtures/canonical-bedroom.json";

const changes = ["Kept in place: Bed, Dresser", "New Shelf 100 × 40 cm, placed by the planner"];

test("an answer comes with what-ifs that can be loaded, previewed and undone, then followed up", async ({ page, request }) => {
  const whatIf = structuredClone(fixture);
  whatIf.requirements.locked_object_ids = ["bed", "dresser"];
  whatIf.objects.push({ id: "new-shelf", label: "Shelf", kind: "shelf", x_cm: 0, y_cm: 0, width_cm: 100, height_cm: 40,
    rotation_deg: 0, movable: true, confirmed: true, label_source: "user-provided", to_place: true } as never);
  const res = await request.post("/api/planner/optimize", { data: { scenario: whatIf, options: { time_limit_s: 5 } } });
  expect(res.ok()).toBe(true);
  const result = await res.json();
  expect(result.status).toBe("solutions_found");
  const summary = { tool: "find_layouts", changes, options: [{ best_for: result.alternatives[0].best_for,
    widest_route_cm: result.alternatives[0].validation.widest_route_cm }] };
  const events = [
    { type: "step", round: 1, kind: "think" },
    { type: "tools", round: 1, calls: [{ id: "call_0", tool: "find_layouts", changes, error: null }] },
    { type: "run", run: { id: "call_0", tool: "find_layouts", changes, scenario: whatIf, result, summary } },
    { type: "step", round: 2, kind: "think" },
    { type: "answer", source: "muse", model: "muse-spark-1.3", note: null,
      text: "Yes: keeping the bed and dresser, the shelf fits once the desk moves. Load the what-if to see the options." },
  ];
  const sent: { history: { same_room: boolean; results: unknown[] }[] }[] = [];
  await page.route("**/api/health", (r) => r.fulfill({ json: { status: "ok", planner: "ok", meta_configured: true } }));
  await page.route("**/api/ai/assistant", async (r) => {
    sent.push(r.request().postDataJSON());
    const reply = sent.length === 1 ? events
      : [{ type: "step", round: 1, kind: "think" }, { type: "answer", source: "muse", model: "muse-spark-1.3",
        text: "The fewest changes option is shown first.", note: "No planner check was run for this answer." }];
    await r.fulfill({ contentType: "application/x-ndjson", body: reply.map((e) => JSON.stringify(e)).join("\n") + "\n" });
  });

  await page.goto("/");
  await page.getByLabel("Ask a question, or say what to change").fill("Keep the dresser too. Would a 100 by 40 cm shelf fit?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Answered by Meta muse-spark-1.3 · every number checked against the planner")).toBeVisible();
  await expect(page.getByText(/the shelf fits once the desk moves/)).toBeVisible();
  await page.getByText("How this was checked (3 steps)").click();
  await expect(page.getByText(/✓ Searching: Kept in place: Bed, Dresser; New Shelf/)).toBeVisible();

  // nothing changed yet; loading puts the what-if and its verified options on screen
  await expect(page.getByRole("button", { name: /^Shelf/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Load this what-if" }).click();
  await expect(page.getByText(/Showing a what-if: Kept in place: Bed, Dresser/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Shelf (not placed yet)" })).toBeVisible();
  const first = page.getByRole("listitem").filter({ hasText: "Fewest changes" });
  await expect(first.getByText(/Shelf \(new\): placed at/)).toBeVisible();
  await first.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("button", { name: /^Shelf, \d+ by \d+ cm at x/ })).toBeVisible(); // drawn where placed

  await page.getByRole("button", { name: "Back to editing" }).click();
  await page.getByRole("button", { name: "Back to my room" }).click();
  await expect(page.getByText(/Showing a what-if/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Shelf/ })).toHaveCount(0);

  // a follow-up carries the earlier results, marked as computed on this same room
  await page.getByLabel("Ask or tell Muse something else").fill("Which option is first?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("The fewest changes option is shown first.")).toBeVisible();
  await expect(page.getByText("No planner check was run for this answer.")).toBeVisible();
  expect(sent[1].history).toEqual([expect.objectContaining({ same_room: true, results: [summary] })]);
});

test("the assistant is off without a Meta key", async ({ page }) => {
  await page.route("**/api/health", (r) => r.fulfill({ json: { status: "ok", planner: "ok", meta_configured: false } }));
  await page.goto("/");
  await page.getByLabel("Ask a question, or say what to change").fill("Does my room work?");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByText(/edit the room and your clearance needs by hand/)).toBeVisible();
});

// A command: Muse's change_room run carries the changed room, checked by the real planner.
async function mockCommand(page: import("@playwright/test").Page, request: import("@playwright/test").APIRequestContext,
  gate: Promise<void> = Promise.resolve()) {
  const moved = structuredClone(fixture);
  moved.objects.find((o) => o.id === "dresser")!.y_cm = 300;
  const res = await request.post("/api/planner/analyze", { data: { scenario: moved } });
  expect(res.ok()).toBe(true);
  const run = { id: "call_0", tool: "change_room", changes: ["Dresser moved to (90, 300)"], scenario: moved,
    result: await res.json(), summary: {} };
  const events = [
    { type: "step", round: 1, kind: "think" },
    { type: "tools", round: 1, calls: [{ id: "call_0", tool: "change_room", changes: run.changes, error: null }] },
    { type: "run", run },
    { type: "step", round: 2, kind: "answer" },
    { type: "answer", source: "muse", model: "muse-spark-1.3", note: null, text: "I moved the Dresser to (90, 300)." },
  ];
  await page.route("**/api/health", (r) => r.fulfill({ json: { status: "ok", planner: "ok", meta_configured: true } }));
  await page.route("**/api/ai/assistant", async (r) => {
    await gate;
    await r.fulfill({ contentType: "application/x-ndjson", body: events.map((e) => JSON.stringify(e)).join("\n") + "\n" });
  });
}

test("a command changes the room at once, and Undo puts it back", async ({ page, request }) => {
  await mockCommand(page, request);
  await page.goto("/");
  await page.getByLabel("Ask a question, or say what to change").fill("Move the dresser down to the bottom wall.");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(page.getByText("Muse changed your room: Dresser moved to (90, 300).")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Dresser, 100 by 50 cm at x 90, y 300/ })).toBeVisible();
  await expect(page.getByText("Changed your room: Dresser moved to (90, 300)", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load this what-if" })).toHaveCount(0); // it is already the room

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText(/Muse changed your room/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Dresser, 100 by 50 cm at x 90, y 165/ })).toBeVisible();
});

test("a command never overwrites edits made while Muse was working", async ({ page, request }) => {
  let open = () => {};
  await mockCommand(page, request, new Promise((resolve) => { open = resolve; }));
  await page.goto("/");
  await page.getByLabel("Ask a question, or say what to change").fill("Move the dresser down to the bottom wall.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: /^Desk, / }).press("ArrowRight"); // edit while waiting
  open();

  await expect(page.getByText("Showing a what-if: Dresser moved to (90, 300).")).toBeVisible();
  await page.getByRole("button", { name: "Back to my room" }).click();
  await expect(page.getByRole("button", { name: /^Dresser, 100 by 50 cm at x 90, y 165/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Desk, .* at x 120,/ })).toBeVisible(); // the edit is kept
});
