// Voice input with Chromium's fake microphone (a test tone). /api/ai/transcribe is mocked;
// the live call is verified separately (see docs/architecture.md).
import { expect, test } from "@playwright/test";

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone"],
});

test("speech is recorded, sent as WAV and added to the text box for review", async ({ page }) => {
  await page.route("**/api/health", (r) => r.fulfill({ json: { status: "ok", planner: "ok", meta_configured: true } }));
  let upload: Buffer | null = null;
  await page.route("**/api/ai/transcribe", async (r) => {
    upload = r.request().postDataBuffer();
    await r.fulfill({ json: { model: "muse-voice-transcribe-1.0", transcript: "I need 36 inches to reach my desk." } });
  });
  await page.goto("/");
  const box = page.getByLabel("In your own words");
  await box.fill("Keep my bed where it is.");

  await page.getByRole("button", { name: "Speak" }).click();
  await expect(page.getByRole("button", { name: /Stop recording/ })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Stop recording/ }).click();

  await expect(box).toHaveValue("Keep my bed where it is. I need 36 inches to reach my desk.");
  await expect(box).toBeFocused(); // ready to review and edit
  // converted in the browser: a RIFF/WAVE file plus the room's furniture names as keywords
  expect(upload!.includes("WAVEfmt ")).toBe(true);
  expect(upload!.toString("latin1")).toContain("Dresser");
  // nothing went to Muse: the person still decides when to turn it into requirements
  await expect(page.getByRole("button", { name: "Turn into requirements" })).toBeEnabled();
});

test("the microphone is off without a Meta key", async ({ page }) => {
  await page.route("**/api/health", (r) => r.fulfill({ json: { status: "ok", planner: "ok", meta_configured: false } }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Speak" })).toBeDisabled();
});
