// Room scanning: the iPhone app's bridge is stubbed with a synthetic RoomPlan scan (no AI involved).
import { expect, test } from "@playwright/test";
import { box, buildScan } from "../tests/scan";

const scan = buildScan({
  walls: box(4, 3.5),
  doors: [{ at: [0, 1], yaw: 270, size: [0.9, 2.1, 0] }],
  objects: [
    { category: "bed", at: [2.5, 1.2], size: [1.4, 0.5, 2] },
    { category: "chair", at: [1, 3], yaw: 75, size: [0.5, 0.9, 0.5] },
  ],
}, 20, [3, -1]);
const file = (name: string, data: unknown) =>
  ({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)) });

test("Scan room in the app opens the scan as an unconfirmed draft plan", async ({ page }) => {
  await page.addInitScript((s) => {
    window.webkit = { messageHandlers: { scanRoom: { postMessage: () => { window.spaceableImportScan?.(s); } } } };
  }, scan);
  await page.goto("/");
  await expect(page.getByText("Planner: online")).toBeVisible();
  await page.getByRole("button", { name: "Scan room" }).click();

  await expect(page.getByRole("list", { name: "Furniture in room" }).getByRole("button")).toHaveText(["Bed", "Chair"]);
  await expect(page.getByLabel("Width").first()).toHaveValue("400");
  await expect(page.getByLabel("Depth")).toHaveValue("350");
  const banner = page.getByRole("status").filter({ hasText: "draft from your room scan" });
  await expect(banner).toContainText("Measure doors with a tape measure");
  await expect(banner.getByRole("listitem")).toHaveText(["Chair was 15° off square and was turned to 90°."]);

  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByText("More information needed before a result")).toBeVisible();
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toBeHidden();
});

test("in a browser there is no Scan room button, but Load JSON takes a raw scan", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Planner: online")).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan room" })).toHaveCount(0);
  const input = page.locator('input[accept="application/json,.json"]');

  const lShape = buildScan({ walls: [...box(4, 3).slice(0, 3), { at: [2, 1.5], yaw: 90, size: [3, 2.4, 0] }] });
  await input.setInputFiles(file("l.json", lShape));
  await expect(page.getByText(/^Could not load l\.json: SpaceAble can only plan rectangular rooms/)).toBeVisible();

  await input.setInputFiles(file("room.json", scan));
  await expect(page.getByText("This plan is a draft from your room scan.")).toBeVisible();
  await expect(page.getByText("Scanned room")).toBeVisible();
});
