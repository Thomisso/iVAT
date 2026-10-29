import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { heicFixture } from "../tests/support/files";

const password = "Playwright-password-82";

async function english(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
}

async function createCompany(page: Page, run: string): Promise<string> {
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Capture Organization ${run}`);
  await page.getByLabel("Email").fill(`capture-${run}@example.test`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Company name").fill(`Capture Company ${run}`);
  const digits = Date.now().toString().slice(-8);
  await page.getByLabel("IČO").fill(digits);
  await page.getByLabel("VAT ID").fill(`CZ${digits}`);
  await page.getByLabel("Street name").fill("Na Příkopě");
  await page.getByLabel("House number").fill("1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/setup\/filing-frequency$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];
  await page.getByLabel("Effective from").fill("2026-01-01");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("button", { name: "Continue without AI" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));
  return companyId;
}

test("mobile capture persists its preview and recovers one photo without losing the batch", async ({
  baseURL,
  context,
  page,
}) => {
  await english(context, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const companyId = await createCompany(page, run);
  await page.goto(`/companies/${companyId}/upload`);

  const camera = page.getByLabel("Take document photo");
  await expect(camera).toHaveAttribute("capture", "environment");
  await expect(camera).toHaveAttribute("accept", /image\/heic/);
  await camera.setInputFiles({
    name: "mobile-receipt.heic",
    mimeType: "image/heic",
    buffer: Buffer.from(heicFixture()),
  });

  const preview = page.getByRole("region", { name: "Photo preview" });
  await expect(preview).toContainText("mobile-receipt.heic");
  await expect(preview.getByRole("button", { name: "Remove photo" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Retake photo" })).toBeVisible();
  await preview.getByRole("button", { name: "Remove photo" }).click();
  await expect(preview).toBeHidden();
  await camera.setInputFiles({
    name: "mobile-receipt.heic",
    mimeType: "image/heic",
    buffer: Buffer.from(heicFixture()),
  });
  const chooser = page.waitForEvent("filechooser");
  await preview.getByRole("button", { name: "Retake photo" }).click();
  await (await chooser).setFiles({
    name: "mobile-receipt.heic",
    mimeType: "image/heic",
    buffer: Buffer.from(heicFixture()),
  });
  await expect(preview).toContainText("mobile-receipt.heic");
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/receipt.jpg");

  await page.goto(`/companies/${companyId}`);
  await page.goto(`/companies/${companyId}/upload`);
  await expect(page.getByRole("status").filter({ hasText: "Draft restored" })).toBeVisible();
  await expect(preview).toContainText("mobile-receipt.heic");

  for (const width of [320, 430]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  expect((await new AxeBuilder({ page }).include(".upload-workspace-new").analyze()).violations).toEqual([]);

  let uploadAttempts = 0;
  await page.route("**/source-files", async (route) => {
    if (!route.request().postDataBuffer()?.includes(Buffer.from("mobile-receipt.heic"))) {
      await route.continue();
      return;
    }
    uploadAttempts += 1;
    if (uploadAttempts <= 2) await route.abort("failed");
    else await route.continue();
  });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("button", { name: "Retry mobile-receipt.heic" })).toBeVisible();
  await expect(page.locator(".upload-items li").filter({ hasText: "receipt.jpg" })).toContainText("Uploaded");
  expect(uploadAttempts).toBe(2);

  await page.getByRole("button", { name: "Retry mobile-receipt.heic" }).click();
  await expect(page).toHaveURL(/\/upload-batches\/[0-9a-f-]+$/);
  expect(uploadAttempts).toBe(3);
  const storedSourceFile = page.getByRole("link", { name: "mobile-receipt.heic" });
  await expect(storedSourceFile).toBeVisible();
  await expect(page.getByRole("link", { name: "receipt.jpg" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for AI setup" })).toBeVisible();
  await storedSourceFile.click();
  await expect(page.getByRole("img", { name: "mobile-receipt.heic" })).toHaveAttribute("src", /\/preview$/);
});
