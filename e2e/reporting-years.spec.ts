import { expect, test } from "@playwright/test";

const password = "Playwright-password-116";

test("an Administrator generates Reporting Years from settings, keeping existing years", async ({ baseURL, context, page }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ico = Date.now().toString().slice(-8);
  const currentYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric" }).format(new Date()));
  const nextYear = currentYear + 1;

  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Reporting Years ${run}`);
  await page.getByLabel("Email").fill(`reporting-years-${run}@example.test`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/companies\/new$/);
  await page.getByLabel("Company name").fill("Roky s.r.o.");
  await page.getByLabel("IČO").fill(ico);
  await page.getByLabel("VAT ID").fill(`CZ${ico}`);
  await page.getByLabel("Street name").fill("Na Příkopě");
  await page.getByLabel("House number").fill("1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/setup\/filing-frequency$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/setup/ai-processing$`));

  // A Document without a period links here with the year it needs.
  await page.goto(`/companies/${companyId}/settings/vat?generateYear=${nextYear}#reporting-years`);
  const reportingYears = page.locator("#reporting-years");
  await expect(reportingYears.getByRole("rowheader")).toHaveText([String(currentYear)]);
  await expect(reportingYears.getByLabel("From year")).toHaveValue(String(nextYear));
  await reportingYears.getByRole("combobox", { name: "Filing frequency", exact: true }).selectOption("quarterly");
  await reportingYears.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(reportingYears.getByText(`Generated: ${nextYear}.`)).toBeVisible();
  await expect(reportingYears.getByRole("rowheader")).toHaveText([String(currentYear), String(nextYear)]);
  await expect(reportingYears.getByLabel(`Filing frequency of Reporting Year ${nextYear}`)).toHaveValue("quarterly");
  await expect(reportingYears.getByLabel(`Filing frequency of Reporting Year ${currentYear}`)).toHaveValue("monthly");

  await reportingYears.getByLabel("From year").fill(String(currentYear - 1));
  await reportingYears.getByLabel("To year").fill(String(nextYear));
  await reportingYears.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(reportingYears.getByText(
    `Generated: ${currentYear - 1}. Already existed and kept: ${currentYear}, ${nextYear}.`,
  )).toBeVisible();
  await expect(reportingYears.getByRole("rowheader"))
    .toHaveText([String(currentYear - 1), String(currentYear), String(nextYear)]);
  await expect(reportingYears.getByLabel(`Filing frequency of Reporting Year ${nextYear}`)).toHaveValue("quarterly");
});
