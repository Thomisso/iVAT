import { provisionAndLogIn } from "./support/accounts";
import { expect, test, type Page } from "@playwright/test";
import { assignBrowserAiConfigurationFixture } from "../tests/support/e2e";

const password = "Playwright-password-123";

async function createCompany(page: Page, run: string): Promise<string> {
  await provisionAndLogIn(page, { organizationName: `Batch Deletion Organization ${run}`, email: `batch-deletion-${run}@example.test`, password });
  await page.getByLabel("Company name").fill(`Batch Deletion Company ${run}`);
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

test("opening a finished batch marks its notification read, and the batch can be deleted", async ({
  baseURL,
  context,
  page,
}) => {
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  await page.setViewportSize({ width: 1280, height: 900 });
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const companyId = await createCompany(page, run);

  await page.goto(`/companies/${companyId}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/two-invoices.pdf");
  await page.getByRole("button", { name: "Upload batch", exact: true }).click();
  await expect(page).toHaveURL(/\/upload-batches\/[0-9a-f-]+$/);
  const batchId = new URL(page.url()).pathname.split("/").at(-1)!;

  // Leave before processing finishes: the completion stays announced as unread.
  await page.goto(`/companies/${companyId}`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("button", { name: "Notifications, 1 unread" })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 45_000 });

  await page.getByRole("button", { name: "Notifications, 1 unread" }).click();
  await page.getByRole("dialog", { name: "Upload notifications" }).getByRole("link", { name: "Open batch" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/upload-batches/${batchId}$`));
  await expect(page.getByRole("button", { name: "Notifications, none unread" })).toBeVisible();

  const deletion = page.getByRole("region", { name: "Delete batch" });
  await expect(deletion.getByRole("definition")).toHaveText(["1", "2", "0"]);
  await deletion.getByLabel(/deleted permanently/).check();
  await deletion.getByRole("button", { name: "Delete batch" }).click();

  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/upload$`));
  await expect(page.getByText("No batches yet. Add Source Files to start one.")).toBeVisible();
  const response = await page.goto(`/companies/${companyId}/upload-batches/${batchId}`);
  expect(response?.status()).toBe(404);
});
