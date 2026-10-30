import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { assignBrowserAiConfigurationFixture } from "../tests/support/e2e";

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
  await expect(page).toHaveURL(/\/documents\?view=review&batchId=[0-9a-f-]+$/);
  const batchId = new URL(page.url()).searchParams.get("batchId");
  expect(batchId).toBeTruthy();

  const savedViews = page.getByRole("navigation", { name: "Saved document views" });
  await savedViews.getByRole("link", { name: "Incoming" }).click();
  await expect(page).toHaveURL(new RegExp(`/documents\\?view=incoming&batchId=${batchId}$`));
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
  await expect(page).toHaveURL(new RegExp(`/documents\\?view=review&batchId=${batchId}#document-[0-9a-f-]+$`));
  await expect(page.getByText("No documents match the filters.")).toBeVisible();
});
