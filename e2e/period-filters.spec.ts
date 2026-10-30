import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { assignBrowserAiConfigurationFixture, setBrowserDocumentTaxPointFixture } from "../tests/support/e2e";

const password = "Playwright-password-83";

async function createAiCompany(context: BrowserContext, page: Page, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const digits = Date.now().toString().slice(-8);
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Period Organization ${run}`);
  await page.getByLabel("Email").fill(`period-${run}@example.test`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Company name").fill(`Period Company ${run}`);
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

async function filterByPeriod(page: Page, form: string, period: string) {
  const filters = page.getByRole("form", { name: form });
  await filters.getByLabel("Reporting Period").selectOption({ label: period });
  await filters.getByRole("button", { name: "Filter" }).click();
}

test("Documents and Upload Batches filter by Reporting Period and by No period", async ({
  baseURL,
  context,
  page,
}) => {
  const companyId = await createAiCompany(context, page, baseURL);
  await page.goto(`/companies/${companyId}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/two-invoices.pdf");
  await page.getByRole("button", { name: "Upload" }).click();
  const reviewBatch = page.getByRole("link", { name: "Review 2 Documents" });
  await expect(reviewBatch).toBeVisible({ timeout: 45_000 });
  await reviewBatch.click();
  const table = page.getByRole("table", { name: "Documents" });
  await expect(table.getByRole("link")).toHaveCount(2);
  const [inPeriod, outsideYears] = await Promise.all([0, 1].map(async (index) => {
    const href = await table.getByRole("link").nth(index).getAttribute("href");
    return href!.split("/documents/")[1].split("?")[0];
  }));
  await setBrowserDocumentTaxPointFixture(inPeriod, { direction: "outgoing", taxPointDate: "2026-03-10" });
  await setBrowserDocumentTaxPointFixture(outsideYears, { direction: "outgoing", taxPointDate: "2025-12-01" });

  await page.goto(`/companies/${companyId}/documents?view=all`);
  await filterByPeriod(page, "Filters", "2026-03");
  await expect(page).toHaveURL(/reportingPeriod=2026-03/);
  await page.reload();
  await expect(page.getByRole("form", { name: "Filters" }).getByLabel("Reporting Period")).toHaveValue("2026-03");
  await expect(table.getByRole("link")).toHaveCount(1);
  await expect(table.getByRole("link")).toHaveAttribute("href", new RegExp(`/documents/${inPeriod}\\?`));
  await filterByPeriod(page, "Filters", "No period");
  await expect(page).toHaveURL(/reportingPeriod=none/);
  await expect(table.getByRole("link")).toHaveCount(1);
  await expect(table.getByRole("link")).toHaveAttribute("href", new RegExp(`/documents/${outsideYears}\\?`));

  await page.goto(`/companies/${companyId}/upload`);
  const history = page.locator(".upload-batch-list li");
  await filterByPeriod(page, "Filters", "2026-04");
  await expect(page.getByText("No batch contains Documents of the selected period.")).toBeVisible();
  await filterByPeriod(page, "Filters", "No period");
  await expect(page).toHaveURL(/reportingPeriod=none/);
  await expect(history).toHaveCount(1);
  await page.reload();
  await expect(history).toHaveCount(1);
});
