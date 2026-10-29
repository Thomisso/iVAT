import { expect, test, type Page } from "@playwright/test";
import { assignBrowserAiConfigurationFixture } from "../tests/support/e2e";

const password = "Playwright-password-124";
const isoDate = /\d{4}-\d{2}-\d{2}/;

// A US browser locale must not switch the format.
test.use({ locale: "en-US", timezoneId: "America/New_York" });

async function createCompany(page: Page, run: string): Promise<string> {
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Dates Organization ${run}`);
  await page.getByLabel("Email").fill(`dates-${run}@example.test`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Company name").fill(`Dates Company ${run}`);
  const digits = Date.now().toString().slice(-8);
  await page.getByLabel("IČO").fill(digits);
  await page.getByLabel("VAT ID").fill(`CZ${digits}`);
  await page.getByLabel("Street name").fill("Na Příkopě");
  await page.getByLabel("House number").fill("1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/setup\/filing-frequency$/);
  return new URL(page.url()).pathname.split("/")[2];
}

test("dates are shown and entered as dd.mm.rrrr regardless of the browser locale", async ({
  baseURL,
  context,
  page,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const companyId = await createCompany(page, run);

  const effectiveFrom = page.getByLabel("Effective from");
  await expect(page.getByText("Format dd.mm.yyyy", { exact: true })).toBeVisible();
  await effectiveFrom.fill("31.02.2026");
  await page.getByRole("button", { name: "Save and continue" }).click();
  const invalidDate = page.getByRole("alert").filter({ hasText: "Enter a valid date as dd.mm.yyyy." });
  await expect(invalidDate).toBeVisible();
  await expect(page).toHaveURL(/\/setup\/filing-frequency$/);
  await effectiveFrom.fill("01.01.2026");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/setup/ai-processing$`));
  await assignBrowserAiConfigurationFixture(companyId);

  await page.goto(`/companies/${companyId}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/two-invoices.pdf");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page).toHaveURL(/\/upload-batches\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^Batch from \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/,
  );
  const review = page.getByRole("link", { name: "Review 2 Documents" });
  await expect(review).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("main")).not.toContainText(isoDate);
  await review.click();

  const table = page.getByRole("table", { name: "Documents" });
  await expect(table.getByRole("row").filter({ hasText: "01.10.2026" })).toHaveCount(2);
  await expect(page.locator("main")).not.toContainText(isoDate);
  await table.getByRole("link").first().click();

  const taxPointDate = page.getByLabel("Tax point date", { exact: true });
  await expect(taxPointDate).toHaveValue("01.10.2026");
  await expect(page.getByLabel("Due date", { exact: true })).toHaveValue("15.10.2026");
  await taxPointDate.fill("2026-10-20");
  await taxPointDate.blur();
  await expect(invalidDate).toBeVisible();
  await taxPointDate.fill("20.10.2026.");
  await page.getByLabel("Direction", { exact: true }).selectOption("incoming");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await expect(page.getByRole("button", { name: "Approve version 2" })).toBeVisible();
  await expect(page.getByLabel("Tax point date", { exact: true })).toHaveValue("20.10.2026");
  await expect(page.locator("main")).not.toContainText(isoDate);
});
