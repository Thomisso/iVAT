import { provisionAndLogIn } from "./support/accounts";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { rotatedHeicFixture } from "../tests/support/files";
import { assignBrowserAiConfigurationFixture } from "../tests/support/e2e";

const password = "Playwright-password-82";

async function english(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
}

async function createCompany(page: Page, run: string): Promise<string> {
  await provisionAndLogIn(page, { organizationName: `Capture Organization ${run}`, email: `capture-${run}@example.test`, password });
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
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/setup/ai-processing$`));
  await assignBrowserAiConfigurationFixture(companyId);
  await page.getByRole("link", { name: "Continue to Company" }).click();
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

  await expect(page.getByLabel("Direction")).toHaveCount(0);
  await expect(page.getByText("Take document photo")).toBeVisible();
  const camera = page.getByLabel("Take document photo");
  await expect(camera).toHaveAttribute("capture", "environment");
  await expect(camera).toHaveAttribute("accept", /image\/heic/);
  await camera.setInputFiles({
    name: "mobile-receipt.heic",
    mimeType: "image/heic",
    buffer: Buffer.from(rotatedHeicFixture()),
  });

  const previews = page.getByRole("region", { name: "Photo preview" });
  const preview = previews.filter({ hasText: "mobile-receipt.heic" });
  await expect(preview).toContainText("mobile-receipt.heic");
  await camera.setInputFiles("tests/fixtures/receipt.png");
  await expect(previews).toHaveCount(2);
  const previewImage = preview.getByRole("img", { name: "Preview of mobile-receipt.heic" });
  await expect.poll(() => previewImage.evaluate((image: HTMLImageElement) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
  }))).toEqual({ width: 16, height: 16 });
  await expect(preview.getByRole("button", { name: "Remove photo" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Retake photo" })).toBeVisible();
  await preview.getByRole("button", { name: "Remove photo" }).click();
  await expect(preview).toBeHidden();
  await camera.setInputFiles({
    name: "mobile-receipt.heic",
    mimeType: "image/heic",
    buffer: Buffer.from(rotatedHeicFixture()),
  });
  const chooser = page.waitForEvent("filechooser");
  await preview.getByRole("button", { name: "Retake photo" }).click();
  await (await chooser).setFiles({
    name: "mobile-receipt.heic",
    mimeType: "image/heic",
    buffer: Buffer.from(rotatedHeicFixture()),
  });
  await expect(preview).toContainText("mobile-receipt.heic");
  await expect(previews).toHaveCount(2);
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

  let heicAttempts = 0;
  let jpegAttempts = 0;
  await page.route("**/source-files", async (route) => {
    const body = route.request().postDataBuffer();
    if (body?.includes(Buffer.from("mobile-receipt.heic"))) {
      heicAttempts += 1;
      if (heicAttempts === 1) {
        await route.fetch();
        await route.abort("failed");
      } else {
        await route.continue();
      }
      return;
    }
    if (body?.includes(Buffer.from("receipt.jpg"))) {
      jpegAttempts += 1;
      if (jpegAttempts <= 2) await route.abort("failed");
      else await route.continue();
      return;
    }
    if (!body) {
      await route.continue();
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Upload batch" }).click();
  await expect(page.getByRole("button", { name: "Retry receipt.jpg" })).toBeVisible();
  await expect(page.locator(".upload-items li").filter({ hasText: "mobile-receipt.heic" })).toContainText("Uploaded");
  expect(heicAttempts).toBe(2);
  expect(jpegAttempts).toBe(2);

  await page.reload();
  await expect(page.getByRole("button", { name: "Retry receipt.jpg" })).toBeVisible();
  await expect(camera).toBeDisabled();
  await expect(page.locator('input[type="file"]:not([capture])')).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove mobile-receipt.heic", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Retry receipt.jpg" }).click();
  await expect(page).toHaveURL(/\/upload-batches\/[0-9a-f-]+$/);
  expect(jpegAttempts).toBe(3);
  expect(heicAttempts).toBe(2);
  const storedSourceFile = page.getByRole("link", { name: "mobile-receipt.heic" });
  await expect(storedSourceFile).toBeVisible();
  await expect(page.getByRole("link", { name: "receipt.jpg" })).toBeVisible();
  await expect(page.getByRole("link", { name: "receipt.png" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review 3 Documents" })).toBeVisible({ timeout: 45_000 });
  await storedSourceFile.click();
  const storedPreview = page.getByRole("img", { name: "mobile-receipt.heic" });
  await expect(storedPreview).toHaveAttribute("src", /\/preview$/);
  await expect.poll(() => storedPreview.evaluate((image: HTMLImageElement) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
  }))).toEqual({ width: 16, height: 16 });
});
