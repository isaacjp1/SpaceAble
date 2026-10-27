// Product features: compare, print, help, persistence, units, cancel.
import { expect, test } from "@playwright/test";

test("before/after compare shows both planner results side by side", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Optimize" }).click();
  await page.getByRole("listitem").filter({ hasText: "Option 1" }).getByRole("button", { name: "Preview" }).click();
  await page.getByRole("button", { name: "Side by side" }).click();
  const before = page.locator("figure").filter({ hasText: "Before" });
  const after = page.locator("figure").filter({ hasText: "After: option 1" });
  await expect(before.getByText("Fail")).toBeVisible();
  await expect(after.getByText("Pass")).toBeVisible();
  await expect(after.getByText(/Verified 80 cm route to desk-approach/)).toBeVisible();
});

test("print view shows the summary instead of the app", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByText("Does not pass the configured checks")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint"))); // as Ctrl+P does
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("heading", { name: "SpaceAble planning summary" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Checks: ✗ Fail/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze" })).toBeHidden();
  const plan = await page.locator("article svg").first().boundingBox();
  expect(plan!.height).toBeGreaterThan(200); // the printed plan has a real size
});

test("help dialog explains the journey and limits", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Help & limits" }).click();
  const dialog = page.getByRole("dialog", { name: "How SpaceAble works" });
  await expect(dialog.getByText(/not modelled/).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test("the last room is kept in the browser and can be restored", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Dresser", exact: true }).click();
  const y = page.getByLabel("Y (top edge)");
  await y.fill("300");
  await y.press("Enter");
  await page.reload();
  await expect(page.getByText("Your room from last time")).toBeVisible();
  // editing the sample first must not lose the saved room
  await page.getByRole("button", { name: "Desk", exact: true }).click();
  await page.keyboard.press("Tab");
  await page.getByRole("button", { name: "Restore it" }).click();
  await page.getByRole("button", { name: "Dresser", exact: true }).click();
  await expect(page.getByLabel("Y (top edge)")).toHaveValue("300");
});

test("inches can be shown next to centimetres", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Show inches").check();
  await expect(page.getByText("430 cm (169.3 in)")).toBeVisible();
});

test("a slow request can be cancelled without an error", async ({ page }) => {
  await page.route("**/api/planner/optimize", () => new Promise(() => {})); // never answers
  await page.goto("/");
  await page.getByRole("button", { name: "Optimize" }).click();
  await expect(page.getByText(/Cancel stops waiting/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Optimize" })).toBeEnabled();
  await expect(page.getByText("Could not reach the SpaceAble server.")).toHaveCount(0);
});
