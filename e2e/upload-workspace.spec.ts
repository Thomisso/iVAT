import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { failOneDocumentInUploadBatch } from "../tests/support/browser-upload";

const password = "Playwright-password-81";

async function english(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
}

async function createCompany(page: Page, run: string): Promise<string> {
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Upload Organization ${run}`);
  await page.getByLabel("Email").fill(`upload-${run}@example.test`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Company name").fill(`Upload Company ${run}`);
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
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/setup/ai-processing$`));
  await page.getByRole("button", { name: "Continue without AI" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));
  return companyId;
}

test("a batch survives waiting and reload, exposes partial recovery, then hands off its complete queue", async ({
  baseURL,
  context,
  page,
}) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const companyId = await createCompany(page, run);

  await page.goto(`/companies/${companyId}/upload`);
  await page.locator('input[type="file"]').setInputFiles("tests/fixtures/two-invoices.pdf");
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page).toHaveURL(/\/upload-batches\/[0-9a-f-]+$/);
  const batchUrl = page.url();
  const batchId = new URL(batchUrl).pathname.split("/").at(-1)!;
  await expect(page.getByRole("heading", { name: "Waiting for AI setup" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Waiting for AI setup" })).toBeVisible();
  await page.getByRole("link", { name: "Set up AI processing" }).click();
  await page.getByRole("radio").first().check();
  await page.getByRole("checkbox", {
    name: /I consent to sending this Company's documents/,
  }).check();
  await page.getByRole("button", { name: "Enable AI processing" }).click();
  await expect(page.getByText(/AI processing is on/)).toBeVisible();

  await page.goto(batchUrl);
  const reviewTwo = page.getByRole("link", { name: "Review 2 Documents" });
  await expect(reviewTwo).toBeVisible({ timeout: 45_000 });

  await failOneDocumentInUploadBatch(batchId);

  await page.reload();
  await expect(page.getByText("Finished with failures", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review 1 Document" })).toBeVisible();
  await page.getByRole("button", { name: "Retry Extraction" }).click();
  await expect(reviewTwo).toBeVisible({ timeout: 45_000 });
  await reviewTwo.click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/documents\\?view=review&batchId=${batchId}$`));
  await expect(page.getByRole("table", { name: "Documents" }).getByRole("link")).toHaveCount(2);
});
