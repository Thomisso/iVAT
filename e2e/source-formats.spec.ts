import { expect, test } from "@playwright/test";
import { provisionAndLogIn } from "./support/accounts";
import { addBrowserSourceFormatFixture } from "../tests/support/e2e";

test("image fields highlight the actual oriented source and Inspect stays explicit through zoom and resize", async ({ page, context, baseURL }, testInfo) => {
  if (!baseURL) throw new Error("Browser base URL required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await provisionAndLogIn(page, { organizationName: `Formats ${run}`, email: `formats-${run}@example.test`, password: "Browser-formats-240" });
  await page.getByLabel("Company name").fill(`Formats ${run}`);
  await page.getByLabel("IČO").fill("25596641");
  await page.getByLabel("VAT ID").fill("CZ25596641");
  await page.getByLabel("Street name").fill("Vinohradská");
  await page.getByLabel("House number").fill("12");
  await page.getByLabel("City", { exact: true }).fill("Praha");
  await page.getByLabel("Postal code", { exact: true }).fill("12000");
  await page.getByRole("button", { name: "Create company", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await expect(page).toHaveURL(/\/setup\/ai-processing$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];
  const { documentId } = await addBrowserSourceFormatFixture({ companyId, cookies: await context.cookies() });
  await page.goto(`/companies/${companyId}/documents/${documentId}`);
  const region = page.locator('[data-source-region="documentNumber"]');
  await expect(region).toBeVisible();
  const inspect = page.getByRole("button", { name: "Inspect", exact: true });
  await expect(inspect).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-source-inspect-crop]")).toHaveCount(0);
  const number = page.getByLabel("Document number", { exact: true });
  await number.fill("UNSAVED-IMAGE");
  await expect(region).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Zoom", { exact: true }).selectOption("2");
  await page.setViewportSize({ width: 1366, height: 900 });
  const rectangle = await region.evaluate(element => {
    const box = element.getBoundingClientRect(); const basis = element.parentElement!.getBoundingClientRect();
    return { x: (box.left - basis.left) / basis.width, y: (box.top - basis.top) / basis.height,
      width: box.width / basis.width, height: box.height / basis.height };
  });
  expect(rectangle.x).toBeCloseTo(0.1, 3);
  expect(rectangle.y).toBeCloseTo(0.1, 3);
  expect(rectangle.width).toBeCloseTo(0.3, 3);
  expect(rectangle.height).toBeCloseTo(0.05, 3);
  await region.click();
  await expect(number).toBeFocused();
  await inspect.click();
  const crop = page.locator("[data-source-inspect-crop] canvas");
  await expect(crop).toBeVisible();
  expect(await crop.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100) ink++;
    return ink;
  })).toBeGreaterThan(20);
  await page.screenshot({ path: testInfo.outputPath("image-inspect.png") });
  await page.keyboard.press("Escape");
  await expect(crop).toHaveCount(0);
  await expect(number).toHaveValue("UNSAVED-IMAGE");
  await page.locator('[data-source-field="supplier.name"] input').focus();
  await expect(inspect).toBeDisabled();
});
