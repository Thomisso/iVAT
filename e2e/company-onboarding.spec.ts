import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { provisionAndLogIn } from "./support/accounts";

const password = "Playwright-password-77";

async function english(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
}

async function provisionAdministrator(page: Page, run: string) {
  await provisionAndLogIn(page, { organizationName: `Onboarding Organization ${run}`, email: `onboarding-${run}@example.test`, password });
  await expect(page).toHaveURL(/\/companies\/new$/);
}

async function completeFrequency(page: Page, companyId: string) {
  await page.getByLabel("Filing frequency").selectOption("quarterly");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/setup/ai-processing$`));
  await page.getByRole("link", { name: "Continue to Company" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));
}

test("legal Company setup uses structured ARES data, resumes, and reaches the focused work overview", async ({ baseURL, context, page }) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ico = Date.now().toString().slice(-8);
  await provisionAdministrator(page, run);

  await page.getByLabel("Person type").selectOption("natural");
  await page.getByLabel("IČO").fill(ico);
  await page.getByRole("button", { name: "Prefill from ARES" }).click();
  await expect(page.getByLabel("Company name")).toHaveValue("ARES Test s.r.o.");
  await expect(page.getByLabel("Person type")).toHaveValue("legal");
  await expect(page.getByLabel("Street name")).toHaveValue("Dlouhá");
  await expect(page.getByLabel("House number")).toHaveValue("12");
  await expect(page.getByLabel("Orientation number (optional)")).toHaveValue("53A");
  await expect(page.getByLabel("City")).toHaveValue("Praha");
  await expect(page.getByLabel("Postal code")).toHaveValue("110 00");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/setup\/filing-frequency$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];

  await page.goto(`/companies/${companyId}`);
  const companyWork = page.getByRole("region", { name: "Company work" });
  await expect(companyWork.getByRole("link", { name: /Upload/ })).toBeVisible();
  await expect(companyWork.getByRole("link", { name: /Documents/ })).toBeVisible();
  await expect(companyWork.getByRole("link", { name: /VAT/ })).toBeVisible();

  await page.goto(`/companies/${companyId}/setup`);
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/setup/filing-frequency$`));
  await completeFrequency(page, companyId);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.goto(`/companies/${companyId}/settings/vat`);
  await page.getByLabel("Tax office").selectOption("451");
  await page.getByLabel("Territorial office").selectOption("2003");
  await page.getByLabel("Economic activity (CZ-NACE)").fill("621000");
  const signatory = page.getByRole("group", { name: "Default authorized signatory" });
  await expect(signatory.getByLabel("First name")).toHaveValue("");
  await expect(signatory.getByLabel("Last name")).toHaveValue("");
  await signatory.getByLabel("First name").fill("Jana");
  await signatory.getByLabel("Last name").fill("Nováková");
  await signatory.getByLabel("Capacity (e.g. director)").fill("director");
  await page.getByLabel("Taxpayer email (optional)").fill("filing@example.test");
  await page.getByLabel("Taxpayer phone (optional)").fill("+420123456789");
  await page.getByRole("button", { name: "Save filing defaults" }).click();
  await expect(page.getByRole("status").getByText("Filing defaults saved.")).toBeVisible();
  await expect(page.getByLabel("Tax office")).toHaveValue("451");
  await page.goto(`/companies/${companyId}/settings/company`);
  await expect(page.getByLabel("Company name")).toHaveValue("ARES Test s.r.o.");
  await page.goto(`/companies/${companyId}`);
  await expect(page.getByRole("region", { name: "Company work" })).toBeVisible();

  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test("natural-person setup derives its immutable name and shows precise EPO compatibility feedback", async ({ baseURL, context, page }) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ico = "90000001";
  await provisionAdministrator(page, run);

  await page.getByLabel("IČO").fill(ico);
  await page.getByRole("button", { name: "Prefill from ARES" }).click();
  await expect(page.getByLabel("Person type")).toHaveValue("natural");
  await expect(page.getByLabel("First name")).toHaveValue("Marie Anna");
  await expect(page.getByLabel("Last name")).toHaveValue("Nováková");
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

  await page.goto(`/companies/${companyId}/settings/company`);
  await page.getByLabel("First name").fill("Changed");
  await page.getByRole("button", { name: "Prefill from ARES" }).click();
  await expect(page.getByLabel("First name")).toHaveValue("Marie Anna");
  await expect(page.getByLabel("Last name")).toHaveValue("Nováková");
  await page.getByLabel("First name").fill("Jana");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/settings$`));

  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "cs", url: new URL(baseURL).origin }]);
  await page.reload();
  await page.goto(`/companies/${companyId}`);
  await expect(page.getByRole("heading", { name: "Přehled" })).toBeVisible();
});

test("incomplete and unavailable ARES identity remains editable without inventing names", async ({ baseURL, context, page }) => {
  await english(context, baseURL);
  await provisionAdministrator(page, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  await page.getByLabel("IČO").fill("90000002");
  await page.getByRole("button", { name: "Prefill from ARES" }).click();
  await expect(page.getByLabel("Person type")).toHaveValue("natural");
  await expect(page.getByLabel("First name")).toHaveValue("Marie Anna");
  await expect(page.getByLabel("Last name")).toHaveValue("");
  await page.getByLabel("Last name").fill("Ručně doplněná");
  await page.getByLabel("IČO").fill("90000003");
  await page.getByRole("button", { name: "Prefill from ARES" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "ARES" })).toBeVisible();
  await expect(page.getByLabel("Last name")).toHaveValue("Ručně doplněná");
  await page.getByLabel("First name").fill("Manual");
  await page.getByLabel("VAT ID").fill("CZ90000003");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/setup\/filing-frequency$/);
});
