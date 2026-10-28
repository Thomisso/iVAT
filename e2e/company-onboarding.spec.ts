import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const password = "Playwright-password-77";

async function english(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
}

async function signUp(page: Page, run: string) {
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Onboarding Organization ${run}`);
  await page.getByLabel("Email").fill(`onboarding-${run}@example.test`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/companies\/new$/);
}

async function completeFrequency(page: Page, companyId: string) {
  await page.getByLabel("Filing frequency").selectOption("quarterly");
  await page.getByLabel("Effective from").fill("2026-10-01");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));
}

test("legal Company setup uses structured ARES data, resumes, and completes the Overview checklist", async ({ baseURL, context, page }) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ico = Date.now().toString().slice(-8);
  await signUp(page, run);

  await page.getByLabel("IČO").fill(ico);
  await page.getByRole("button", { name: "Prefill from ARES" }).click();
  await expect(page.getByLabel("Company name")).toHaveValue("ARES Test s.r.o.");
  await expect(page.getByLabel("Street name")).toHaveValue("Dlouhá");
  await expect(page.getByLabel("House number")).toHaveValue("12");
  await expect(page.getByLabel("Orientation number (optional)")).toHaveValue("53A");
  await expect(page.getByLabel("City")).toHaveValue("Praha");
  await expect(page.getByLabel("Postal code")).toHaveValue("110 00");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/setup\/filing-frequency$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];

  await page.goto(`/companies/${companyId}`);
  const checklist = page.getByRole("region", { name: "Company setup" });
  await expect(checklist.getByText("Taxpayer identity").locator("..")).toContainText("Completed");
  await expect(checklist.getByText("Filing frequency").locator("..")).toContainText("Required");
  await expect(checklist.getByText("Export and tax office").locator("..")).toContainText("Skipped for now");

  await page.goto(`/companies/${companyId}/setup`);
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/setup/filing-frequency$`));
  await completeFrequency(page, companyId);
  await expect(checklist.getByText("Filing frequency").locator("..")).toContainText("Completed");

  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test("natural-person setup derives its immutable name and shows precise EPO compatibility feedback", async ({ baseURL, context, page }) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ico = Date.now().toString().slice(-8);
  await signUp(page, run);

  await page.getByLabel("Person type").selectOption("natural");
  await expect(page.getByLabel("Company name")).toHaveCount(0);
  await page.getByLabel("First name").fill("Jana");
  await page.getByLabel("Last name").fill("Nováková");
  await page.getByLabel("IČO").fill(ico);
  await page.getByLabel("VAT ID").fill(`CZ${ico}`);
  await page.getByLabel("Street name").fill("x".repeat(39));
  await expect(page.getByText(/exceeds the 38-character EPO limit/)).toBeVisible();
  await page.getByLabel("Street name").fill("Vinohradská");
  await page.getByLabel("House number").fill("12");
  await page.getByLabel("Orientation number (optional)").fill("53A");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("12000");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/setup\/filing-frequency$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];
  await completeFrequency(page, companyId);
  await expect(page.getByText("Your work for Jana Nováková, in one place.")).toBeVisible();

  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "cs", url: new URL(baseURL).origin }]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Nastavení firmy" })).toBeVisible();
});
