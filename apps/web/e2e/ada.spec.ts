// The ADA reference check against the real planner on the sample bedroom (no AI involved).
import { expect, test } from "@playwright/test";

test("the ADA reference check reports each modelled rule and never claims compliance", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Planner: online")).toBeVisible();
  await page.getByRole("button", { name: "ADA reference check" }).click();

  const panel = page.getByRole("region", { name: "ADA reference check" });
  await expect(panel.getByText(/^ADA 2010 reference check: \d of 5 rules pass$/)).toBeVisible();
  await expect(panel.getByText(/not a compliance determination/)).toBeVisible();
  const row = (rule: string) => panel.getByRole("listitem").filter({ hasText: rule });
  await expect(row("404.2.3 Door clear width")).toContainText("Pass"); // the 90 cm door ≥ 32 in
  await expect(row("806.2.3")).toContainText("Fail"); // the bed is 20 cm from the right wall
  await expect(row("806.2.3")).toContainText("Bed (right side)");
  await expect(panel.getByText("Not checked by SpaceAble (10 areas)")).toBeVisible();

  // the person's own requirements are untouched
  await expect(page.getByLabel("Route width")).toHaveValue("80");
  // the ADA copy can be inspected on the plan, then put away
  await panel.getByRole("button", { name: "Show on the plan" }).click();
  await expect(page.getByText(/Showing a what-if: ADA 2010 reference/)).toBeVisible();
  await expect(page.getByLabel("Route width")).toHaveValue("91.44");
  await page.getByRole("button", { name: "Back to my room" }).click();
  await expect(page.getByLabel("Route width")).toHaveValue("80");
  await expect(panel).toBeVisible(); // still current for this room
});
