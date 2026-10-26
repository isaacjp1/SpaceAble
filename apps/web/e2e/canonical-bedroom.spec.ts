import { expect, test } from "@playwright/test";

test("sample bedroom fails for the dresser, then passes after the user moves it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Planner: online")).toBeVisible();

  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByText("Does not pass the configured checks")).toBeVisible();
  await expect(page.getByText("Approach zone for desk-approach overlaps dresser.")).toBeVisible();

  // clicking (selecting) a piece is not an edit, so results must stay current
  const bed = (await page.getByRole("button", { name: /^Bed, 150 by 200 cm/ }).boundingBox())!;
  await page.mouse.move(bed.x + 40, bed.y + 40);
  await page.mouse.down();
  await page.mouse.move(bed.x + 41, bed.y + 41);
  await page.mouse.up();
  await expect(page.getByText("The layout changed since this analysis")).toHaveCount(0);

  // keyboard/inspector path (dragging is not the only input method)
  await page.getByRole("button", { name: "Dresser", exact: true }).click();
  const y = page.getByLabel("Y (top edge)");
  await y.fill("300");
  await y.press("Enter");
  await expect(page.getByText("The layout changed since this analysis")).toBeVisible();

  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByText("Passes the configured geometric checks")).toBeVisible();
  await expect(page.getByText(/Verified 80 cm route to desk-approach/)).toBeVisible();
});

test("furniture moves by drag and arrow keys, rotates, and can be deleted", async ({ page }) => {
  await page.goto("/");
  const desk = page.getByRole("button", { name: /^Desk, 110 by 65 cm/ });
  await desk.focus();
  await expect(page.getByLabel("X (left edge)")).toHaveValue("115");

  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("X (left edge)")).toHaveValue("120");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByLabel("Y (top edge)")).toHaveValue("55");

  const box = (await desk.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const x = Number(await page.getByLabel("X (left edge)").inputValue());
  expect(x).toBeGreaterThan(120);
  expect(x % 5).toBe(0); // snapped to the 5 cm grid

  await page.getByRole("button", { name: "Rotate 90°" }).click();
  await expect(page.getByText("now 90°")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Desk, 65 by 110 cm/ })).toBeVisible();

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Desk,/ })).toHaveCount(0);
  await expect(page.getByText("desk-approach")).toHaveCount(0); // its approach zone went with it
});

test("optimize returns verified alternatives that can be previewed and applied", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Planner: online")).toBeVisible();

  await page.getByRole("button", { name: "Optimize" }).click();
  await expect(page.getByText("Verified alternatives", { exact: true })).toBeVisible();
  await expect(page.getByText(/Ran the validator on \d+ of \d+ combinations/)).toBeVisible();
  // the optimizer's baseline is the same validator's verdict on the current layout
  await expect(page.getByText("Does not pass the configured checks")).toBeVisible();

  const first = page.getByRole("listitem").filter({ hasText: "Option 1" });
  await expect(first.getByText(/moved \d+(\.\d)? cm/)).toBeVisible();
  await first.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("Previewing option 1 (read-only)")).toBeVisible();
  await expect(page.locator("text=(before)").first()).toBeVisible(); // ghost of the old spot
  await expect(page.locator('line[marker-end="url(#arrow)"]').first()).toBeVisible();
  await expect(page.getByText("Passes the configured geometric checks")).toBeVisible();

  await page.getByRole("button", { name: "Use this layout" }).first().click();
  await expect(page.getByText("Previewing option 1")).toHaveCount(0);
  // recompute from scratch on the applied layout
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByText("Passes the configured geometric checks")).toBeVisible();
  await expect(page.getByText("The layout changed since this analysis")).toHaveCount(0);
});
