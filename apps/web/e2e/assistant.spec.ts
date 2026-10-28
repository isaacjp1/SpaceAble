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
  const summary = { tool: "find_layouts", changes, options: [{ option: 1, widest_route_cm: result.alternatives[0].validation.widest_route_cm }] };
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
        text: "Option 1 is the one shown first.", note: "No planner check was run for this answer." }];
    await r.fulfill({ contentType: "application/x-ndjson", body: reply.map((e) => JSON.stringify(e)).join("\n") + "\n" });
  });

  await page.goto("/");
  await page.getByLabel("Ask a question").fill("Keep the dresser too. Would a 100 by 40 cm shelf fit?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText("Answered by Meta muse-spark-1.3 · every number checked against the planner")).toBeVisible();
  await expect(page.getByText(/the shelf fits once the desk moves/)).toBeVisible();
  await page.getByText("How this was checked (3 steps)").click();
  await expect(page.getByText(/✓ Searching: Kept in place: Bed, Dresser; New Shelf/)).toBeVisible();

  // nothing changed yet; loading puts the what-if and its verified options on screen
  await expect(page.getByRole("button", { name: /^Shelf/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Load this what-if" }).click();
  await expect(page.getByText(/Showing a what-if from the assistant: Kept in place: Bed, Dresser/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Shelf (not placed yet)" })).toBeVisible();
  const first = page.getByRole("listitem").filter({ hasText: "Option 1" });
  await expect(first.getByText(/Shelf \(new\): placed at/)).toBeVisible();
  await first.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("button", { name: /^Shelf, \d+ by \d+ cm at x/ })).toBeVisible(); // drawn where placed

  await page.getByRole("button", { name: "Back to editing" }).click();
  await page.getByRole("button", { name: "Back to my room" }).click();
  await expect(page.getByText(/Showing a what-if/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Shelf/ })).toHaveCount(0);

  // a follow-up carries the earlier results, marked as computed on this same room
  await page.getByLabel("Ask a follow-up").fill("Which option is first?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText("Option 1 is the one shown first.")).toBeVisible();
  await expect(page.getByText("No planner check was run for this answer.")).toBeVisible();
  expect(sent[1].history).toEqual([expect.objectContaining({ same_room: true, results: [summary] })]);
});

test("the assistant is off without a Meta key", async ({ page }) => {
  await page.route("**/api/health", (r) => r.fulfill({ json: { status: "ok", planner: "ok", meta_configured: false } }));
  await page.goto("/");
  await page.getByLabel("Ask a question").fill("Does my room work?");
  await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeDisabled();
});
