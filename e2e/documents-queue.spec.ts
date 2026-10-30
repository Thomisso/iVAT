import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { assignBrowserAiConfigurationFixture, addBrowserLegacyRateBreakdownVersionFixture, setBrowserDocumentTaxPointFixture } from "../tests/support/e2e";

const password = "Playwright-password-83";

async function createAiCompany(context: BrowserContext, page: Page, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const digits = Date.now().toString().slice(-8);
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Queue Organization ${run}`);
  await page.getByLabel("Email").fill(`queue-${run}@example.test`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Company name").fill(`Queue Company ${run}`);
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

test("saved views preserve queue context while review decisions advance through the queue", async ({
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
  await expect(page).toHaveURL((url) => url.pathname === `/companies/${companyId}/documents` && url.searchParams.get("view") === "review" && Boolean(url.searchParams.get("batchId")));
  const batchId = new URL(page.url()).searchParams.get("batchId");
  expect(batchId).toBeTruthy();

  const savedViews = page.getByRole("navigation", { name: "Saved document views" });
  await savedViews.getByRole("link", { name: "Incoming" }).click();
  await expect(page).toHaveURL((url) => url.pathname === `/companies/${companyId}/documents` && url.searchParams.get("view") === "incoming" && url.searchParams.get("batchId") === batchId);
  expect(new URL(page.url()).searchParams.has("direction")).toBe(false);
  await savedViews.getByRole("link", { name: "Needs review" }).click();

  const table = page.getByRole("table", { name: "Documents" });
  await expect(table.getByRole("link")).toHaveCount(2);
  await table.getByRole("link").first().click();
  await expect(page.getByText("Document 1 of 2", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Next →" }).click();
  await expect(page.getByText("Document 2 of 2", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "← Previous" }).click();
  await expect(page.getByText("Document 1 of 2", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Next →" }).click();
  await expect(page.getByText("Document 2 of 2", { exact: true })).toBeVisible();

  await page.getByLabel("Document number", { exact: true }).fill(`QUEUE-${Date.now()}`);
  await page.getByLabel("Direction", { exact: true }).selectOption("incoming");
  await page.getByRole("button", { name: "Save corrections" }).click();
  const approve = page.getByRole("button", { name: "Approve version 2" });
  await expect(approve).toBeVisible();
  await approve.click();
  await expect(page.getByText("Document 1 of 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page).toHaveURL((url) => url.pathname === `/companies/${companyId}/documents` && url.searchParams.get("view") === "review" && url.searchParams.get("batchId") === batchId && /^#document-[0-9a-f-]+$/.test(url.hash));
  await expect(page.getByText("No documents match the filters.")).toBeVisible();
});

test("historical empty rates stay hidden without moving findings, zero VAT or Credit Note amounts", async ({ baseURL, context, page }) => {
  const companyId = await createAiCompany(context, page, baseURL);
  await page.goto(`/companies/${companyId}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/receipt.png");
  await page.getByRole("button", { name: "Upload batch", exact: true }).click();
  const review = page.getByRole("link", { name: "Review 1 Document", exact: true });
  await expect(review).toBeVisible({ timeout: 45_000 });
  await review.click();
  await page.getByRole("table", { name: "Documents" }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+(?:\?|$)/);
  const documentId = new URL(page.url()).pathname.split("/documents/")[1];
  await addBrowserLegacyRateBreakdownVersionFixture(documentId);
  await page.goto(`/companies/${companyId}/documents/${documentId}`);
  const amounts = page.getByRole("group", { name: "Rate breakdown and totals", exact: true });
  const nets = amounts.getByRole("textbox", { name: "Net", exact: true });
  const vats = amounts.getByRole("textbox", { name: "VAT", exact: true });
  await expect(nets).toHaveCount(2, { timeout: 1_000 });
  await expect(nets.nth(0)).toHaveValue("-50.00");
  await expect(nets.nth(1)).toHaveValue("-100.00");
  await expect(vats.nth(0)).toHaveValue("0.00");
  await expect(vats.nth(1)).toHaveValue("-20.00");
  await expect(vats.nth(1)).toHaveAccessibleDescription("VAT does not match the net amount and rate.");
  await expect(vats.nth(0)).not.toHaveAttribute("aria-invalid", "true");
  const conversion = page.getByRole("group", { name: "CZK conversion", exact: true });
  await expect(conversion.getByRole("row")).toHaveCount(3);
  await expect(conversion).toContainText("-1250.00");
  await expect(conversion).toContainText("-2500.00");
  // This explicit correction also removes the historical foreign conversion, without a live rate request.
  await page.getByLabel("Currency", { exact: true }).fill("CZK");
  await page.getByRole("button", { name: "Save corrections", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve version 3", exact: true })).toBeVisible();
  await expect(nets).toHaveCount(2);
  await page.getByRole("link", { name: /^Version 2:/ }).click();
  await expect(nets).toHaveCount(2);
  await expect(vats.nth(1)).toHaveValue("-20.00");
  await expect(vats.nth(1)).toBeDisabled();
  await expect(vats.nth(1)).toHaveAccessibleDescription("VAT does not match the net amount and rate.");
  await expect(conversion.getByRole("row")).toHaveCount(3);
});

test("Document returns restore the filtered selection after viewing and editing, with safe direct-entry fallbacks", async ({ baseURL, context, page }) => {
  const companyId = await createAiCompany(context, page, baseURL);
  await page.goto(`/companies/${companyId}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/receipt.png");
  await page.getByRole("button", { name: "Upload batch", exact: true }).click();
  const review = page.getByRole("link", { name: "Review 1 Document", exact: true });
  await expect(review).toBeVisible({ timeout: 45_000 });
  await review.click();
  await page.getByRole("table", { name: "Documents" }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+(?:\?|$)/);
  const documentId = new URL(page.url()).pathname.split("/documents/")[1];
  await setBrowserDocumentTaxPointFixture(documentId, { direction: "incoming", taxPointDate: "2026-10-10" });
  const list = `/companies/${companyId}/documents?view=all&direction=incoming&reportingPeriod=2026-10&counterparty=Dodavatel&page=3`;
  await page.goto(list);
  await page.getByRole("table", { name: "Documents" }).getByRole("link").first().click();
  const back = page.getByRole("link", { name: "← Back to Documents", exact: true });
  await expect(back).toHaveAttribute("href", `${list}#document-${documentId}`);
  await back.click();
  await expect(page).toHaveURL(`${baseURL}${list}#document-${documentId}`);
  await page.getByRole("table", { name: "Documents" }).getByRole("link").first().click();
  await page.getByLabel("Direction", { exact: true }).selectOption("outgoing");
  const save = page.getByRole("button", { name: "Save corrections", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("button", { name: "Approve version 2", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Direction", { exact: true })).toHaveValue("outgoing");
  await back.click();
  await expect(page).toHaveURL(`${baseURL}${list}#document-${documentId}`);
  await expect(page.getByText("No documents match the filters.")).toBeVisible();
  for (const returnTo of [null, "https://evil.test", "//evil.test", "/companies/00000000-0000-4000-8000-000000000999/documents"]) {
    await page.goto(`/companies/${companyId}/documents/${documentId}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`);
    await expect(back).toHaveAttribute("href", `/companies/${companyId}/documents`);
  }
  await context.addCookies([{ name: "NEXT_LOCALE", value: "cs", url: baseURL! }]);
  await page.reload();
  await expect(page.getByRole("link", { name: "← Zpět na doklady", exact: true })).toHaveAttribute("href", `/companies/${companyId}/documents`);
});
