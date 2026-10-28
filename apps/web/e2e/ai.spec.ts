// UI flows for the Meta features. /api/ai/* is mocked: no paid inference in e2e.
// Live behaviour is verified separately (see docs/architecture.md).
import { expect, test, type Page } from "@playwright/test";

async function withMeta(page: Page, configured = true) {
  await page.route("**/api/health", (r) => r.fulfill({ json: { status: "ok", planner: "ok", meta_configured: configured } }));
}

test("explanations are labelled by source and show why a draft was discarded", async ({ page }) => {
  await withMeta(page);
  await page.route("**/api/ai/explain", (r) => r.fulfill({ json: {
    source: "template", text: "Current layout: It does not pass.",
    note: "Muse's draft was discarded because it mentions 120, which is not in the planner's evidence.",
  } }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Explain" })).toBeDisabled(); // nothing analysed yet
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByText("Does not pass the configured checks")).toBeVisible();
  await page.getByRole("button", { name: "Explain" }).click();
  await expect(page.getByText("Built-in explanation (no AI)")).toBeVisible();
  await expect(page.getByText(/mentions 120, which is not in the planner's evidence/)).toBeVisible();
});

test("SAM detections overlay the photo and are linked to plan furniture by the user", async ({ page }) => {
  await withMeta(page);
  let sent: string[] = [];
  await page.route("**/api/ai/segment", async (r) => {
    sent = (r.request().postData() ?? "").match(/name="concept"\r\n\r\n([^\r]+)/g) ?? [];
    await r.fulfill({ json: { model: "sam-3.1", image: { width: 1280, height: 960 }, results: [
      { concept: "bed", complete: true, dropped_records: 0, detections: [
        { id: "bed-0", label: "bed", box_px: [42, 578, 557, 960], confidence: 0.57, mask: null }] },
      { concept: "piano", complete: true, dropped_records: 0, detections: [] },
    ] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Photo (SAM 3.1)" }).click();
  await page.getByRole("button", { name: "Use sample photo" }).click();
  await expect(page.getByRole("img", { name: /Sample: hostel twin room/ })).toBeVisible();
  await page.getByLabel("Look for").fill("bed, piano");
  await page.getByRole("button", { name: "Detect with SAM 3.1" }).click();

  await expect(page.getByText("“bed”: 1 found")).toBeVisible();
  await expect(page.getByText("No piano found in this photo")).toBeVisible();
  expect(sent).toHaveLength(2); // one concept per SAM request

  await page.getByLabel("Plan furniture").selectOption({ label: "Bed" });
  await expect(page.locator("svg text", { hasText: "bed #1 → Bed" })).toBeVisible();

  // the plan is untouched by detections; switching back still shows the same room
  await page.getByRole("button", { name: "Floor plan" }).click();
  await expect(page.getByRole("button", { name: /^Bed, 150 by 200 cm/ })).toBeVisible();
});
