// UI flows for the Meta features. /api/ai/* is mocked: no paid inference in e2e.
// Live behaviour is verified separately (see docs/architecture.md).
import { expect, test, type Page } from "@playwright/test";

async function withMeta(page: Page, configured = true) {
  await page.route("**/api/health", (r) => r.fulfill({ json: { status: "ok", planner: "ok", meta_configured: configured } }));
}

test("without a key the AI controls explain why they are off", async ({ page }) => {
  await withMeta(page, false);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Turn into requirements" })).toBeDisabled();
  await expect(page.getByText(/set requirements by hand/)).toBeVisible();
});

test("a Muse proposal is reviewed, edited and applied by the user", async ({ page }) => {
  await withMeta(page);
  await page.route("**/api/ai/parse-request", (r) => r.fulfill({ json: { model: "muse-spark-1.3", proposal: {
    locked_object_ids: ["bed"], required_destination_ids: ["desk-approach"], route_width_cm: 91.44,
    turning_diameter_cm: null, optimization_profile: "minimal_changes", clarifying_questions: [],
    unsupported_requests: ["check if doorway meets ADA"],
  } } }));
  await page.goto("/");
  await page.getByLabel("In your own words").fill("I need 36 inches to reach my desk; leave the bed alone.");
  await page.getByRole("button", { name: "Turn into requirements" }).click();

  const review = page.getByRole("group", { name: /Proposed by Meta muse-spark-1.3/ });
  await expect(review).toBeVisible();
  await expect(review.getByText("check if doorway meets ADA")).toBeVisible();
  await expect(review.getByLabel("Route width")).toHaveValue("91.44");
  // nothing is applied until the user approves
  await expect(page.getByLabel("Route width")).toHaveCount(2);

  await review.getByRole("button", { name: "Apply to my requirements" }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByLabel("Route width")).toHaveValue("91.44");
});

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
  await page.getByRole("tab", { name: "Photo (SAM 3.1)" }).click();
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
  await page.getByRole("tab", { name: "Floor plan" }).click();
  await expect(page.getByRole("button", { name: /^Bed, 150 by 200 cm/ })).toBeVisible();
});
