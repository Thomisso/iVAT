import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { currentReportingYear } from "../src/application/reporting-periods";
import { assignBrowserAiConfigurationFixture, setBrowserDocumentTaxPointFixture, setBrowserUploadHistoryFixture } from "../tests/support/e2e";

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

test("Document period filters remain available while mixed-period batches filter by creation days", async ({
  baseURL,
  context,
  page,
}) => {
  const companyId = await createAiCompany(context, page, baseURL);
  // Onboarding generates only the current Reporting Year (monthly), so the previous year has No period.
  const year = currentReportingYear();
  await page.goto(`/companies/${companyId}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles(["tests/fixtures/two-invoices.pdf", "tests/fixtures/receipt.png"]);
  await page.getByRole("button", { name: "Upload" }).click();
  const reviewBatch = page.getByRole("link", { name: "Review 3 Documents" });
  await expect(reviewBatch).toBeVisible({ timeout: 45_000 });
  const batchId = new URL(page.url()).pathname.split("/upload-batches/")[1];
  await reviewBatch.click();
  const table = page.getByRole("table", { name: "Documents" });
  await expect(table.getByRole("link")).toHaveCount(3);
  const [inPeriod, outsideYears, april] = await Promise.all([0, 1, 2].map(async (index) => {
    const href = await table.getByRole("link").nth(index).getAttribute("href");
    return href!.split("/documents/")[1].split("?")[0];
  }));
  await setBrowserDocumentTaxPointFixture(inPeriod, { direction: "outgoing", taxPointDate: `${year}-03-10` });
  await setBrowserDocumentTaxPointFixture(outsideYears, { direction: "outgoing", taxPointDate: `${year - 1}-12-01` });
  await setBrowserDocumentTaxPointFixture(april, { direction: "outgoing", taxPointDate: `${year}-04-02` });

  await page.goto(`/companies/${companyId}/documents?view=all`);
  await filterByPeriod(page, "Filters", `${year}-03`);
  await expect(page).toHaveURL(new RegExp(`reportingPeriod=${year}-03`));
  await page.reload();
  await expect(page.getByRole("form", { name: "Filters" }).getByLabel("Reporting Period")).toHaveValue(`${year}-03`);
  await expect(table.getByRole("link")).toHaveCount(1);
  await expect(table.getByRole("link")).toHaveAttribute("href", new RegExp(`/documents/${inPeriod}\\?`));
  await filterByPeriod(page, "Filters", "No period");
  await expect(page).toHaveURL(/reportingPeriod=none/);
  await expect(table.getByRole("link")).toHaveCount(1);
  await expect(table.getByRole("link")).toHaveAttribute("href", new RegExp(`/documents/${outsideYears}\\?`));
  await filterByPeriod(page, "Filters", `${year}-04`);
  await expect(table.getByRole("link")).toHaveCount(1);
  await expect(table.getByRole("link")).toHaveAttribute("href", new RegExp(`/documents/${april}\\?`));

  await setBrowserUploadHistoryFixture(companyId, [
    { batchId, createdAt: "2026-03-29T10:00:00.000Z" },
    { createdAt: "2026-03-28T22:59:59.999Z" },
    { createdAt: "2026-03-29T22:00:00.000Z" },
  ]);
  await page.goto(`/companies/${companyId}/upload`);
  const history = page.locator(".upload-batch-list li");
  const filters = page.getByRole("form", { name: "Batch filters" });
  await expect(filters.getByLabel("Reporting Period")).toHaveCount(0);
  await filters.getByLabel("Uploaded from", { exact: true }).fill("29.03.2026");
  await filters.getByLabel("Choose date for Uploaded to", { exact: true }).fill("2026-03-29");
  await filters.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/createdFrom=2026-03-29&createdTo=2026-03-29/);
  await expect(history).toHaveCount(1);
  const batchHref = await history.getByRole("link").getAttribute("href");
  if (!batchHref) throw new Error("Batch history link is missing");
  const batchDestination = new URL(batchHref, baseURL);
  const historyOrigin = `/companies/${companyId}/upload?createdFrom=2026-03-29&createdTo=2026-03-29#batch-${batchId}`;
  expect(batchDestination.pathname).toBe(`/companies/${companyId}/upload-batches/${batchId}`);
  expect(Object.fromEntries(batchDestination.searchParams)).toEqual({ returnTo: historyOrigin });
  await history.getByRole("link").click();
  await expect(page).toHaveURL((url) => url.pathname === batchDestination.pathname && url.searchParams.size === 1 && url.searchParams.get("returnTo") === historyOrigin);
  await page.getByRole("link", { name: "← Back to Upload", exact: true }).click();
  await expect(page).toHaveURL(new URL(historyOrigin, baseURL).href);
  await page.reload();
  await expect(filters.getByLabel("Uploaded from", { exact: true })).toHaveValue("29.03.2026");
  await expect(filters.getByLabel("Uploaded to", { exact: true })).toHaveValue("29.03.2026");
  await expect(history).toHaveCount(1);
  await filters.getByLabel("Uploaded from", { exact: true }).fill("");
  await filters.getByRole("button", { name: "Filter" }).click();
  await expect(history).toHaveCount(2);
  await filters.getByLabel("Uploaded from", { exact: true }).fill("31.03.2026");
  await filters.getByLabel("Uploaded to", { exact: true }).fill("");
  await filters.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByText("No batch was created in the selected date range.")).toBeVisible();
  await filters.getByRole("link", { name: "Clear filters" }).click();
  await expect(history).toHaveCount(3);
  await expect(filters.getByLabel("Uploaded from", { exact: true })).toHaveValue("");
  await expect(filters.getByLabel("Uploaded to", { exact: true })).toHaveValue("");
});

test("batch date bounds persist through history pages while the Company upload queue remains intact", async ({ baseURL, context, page }) => {
  const companyId = await createAiCompany(context, page, baseURL);
  await setBrowserUploadHistoryFixture(companyId, [
    ...Array.from({ length: 22 }, (_, index) => ({ createdAt: `2026-10-25T12:00:00.${String(index).padStart(3, "0")}Z` })),
    { createdAt: "2026-10-25T23:00:00.000Z" },
  ]);
  await page.goto(`/companies/${companyId}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/receipt.png");
  await expect(page.locator(".upload-items li")).toHaveCount(1);
  const filters = page.getByRole("form", { name: "Batch filters" });
  await filters.getByLabel("Uploaded from", { exact: true }).fill("25.10.2026");
  await filters.getByLabel("Uploaded to", { exact: true }).fill("25.10.2026");
  await filters.getByRole("button", { name: "Filter" }).click();
  await expect(page.locator(".upload-batch-list li")).toHaveCount(20);
  await page.getByRole("link", { name: "Older batches →" }).click();
  await expect(page).toHaveURL(/createdFrom=2026-10-25&createdTo=2026-10-25&historyPage=2/);
  await expect(page.locator(".upload-batch-list li")).toHaveCount(2);
  await expect(page.locator(".upload-items li")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".upload-batch-list li")).toHaveCount(2);
  await expect(page.locator(".upload-items li")).toHaveCount(1);
  const historyUrl = new URL(page.url());
  const batchLink = page.locator(".upload-batch-list li").first().getByRole("link");
  const batchId = (await batchLink.getAttribute("href"))!.split("/upload-batches/")[1].split("?")[0];
  await batchLink.click();
  await page.getByRole("link", { name: "← Back to Upload", exact: true }).click();
  historyUrl.hash = `batch-${batchId}`;
  await expect(page).toHaveURL(historyUrl.href);
  await expect(page.locator(".upload-batch-list li")).toHaveCount(2);
  await expect(page.locator(".upload-items li")).toHaveCount(1);
  await page.getByRole("link", { name: "← Newer batches" }).click();
  await expect(page.locator(".upload-batch-list li")).toHaveCount(20);
  await expect(filters.getByLabel("Uploaded from", { exact: true })).toHaveValue("25.10.2026");
});


test("an incoming Document chooses and clears its Deferred Claim from generated periods", async ({ baseURL, context, page }) => {
  const companyId = await createAiCompany(context, page, baseURL);
  const year = currentReportingYear();
  await page.goto(`/companies/${companyId}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/two-invoices.pdf");
  await page.getByRole("button", { name: "Upload" }).click();
  const reviewBatch = page.getByRole("link", { name: "Review 2 Documents" });
  await expect(reviewBatch).toBeVisible({ timeout: 45_000 });
  await reviewBatch.click();
  const href = await page.getByRole("table", { name: "Documents" }).getByRole("link").first().getAttribute("href");
  const documentId = href!.split("/documents/")[1].split("?")[0];
  await setBrowserDocumentTaxPointFixture(documentId, { direction: "incoming", taxPointDate: `${year}-10-10` });
  await page.goto(`/companies/${companyId}/documents/${documentId}`);
  const claim = page.getByRole("combobox", { name: "Move input VAT claim to" });
  await expect(claim.locator("option")).toHaveText(["Tax Point Date period (no deferral)", `${year}-11`, `${year}-12`]);
  await claim.selectOption(`${year}-12`);
  await page.getByRole("button", { name: "Save Reporting Period" }).click();
  await expect(page.getByRole("button", { name: "Save Reporting Period", exact: true })).toBeEnabled();
  await page.reload();
  await expect(claim).toHaveValue(`${year}-12`);
  await claim.selectOption("");
  await page.getByRole("button", { name: "Save Reporting Period" }).click();
  await expect(page.getByRole("button", { name: "Save Reporting Period", exact: true })).toBeEnabled();
  await page.reload();
  await expect(claim).toHaveValue("");
});
