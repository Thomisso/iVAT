import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const password = "Playwright-password-97";

async function english(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
}

async function createCompanyAdministrator(page: Page) {
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ico = Date.now().toString().slice(-8);
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Export Organization ${run}`);
  await page.getByLabel("Email").fill(`export-admin-${run}@example.test`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/companies\/new$/);
  await page.getByLabel("Company name").fill(`Export Company ${run}`);
  await page.getByLabel("IČO").fill(ico);
  await page.getByLabel("VAT ID").fill(`CZ${ico}`);
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

test("a Company Administrator downloads data without beginning deletion", async ({ baseURL, context, page }) => {
  await english(context, baseURL);
  const companyId = await createCompanyAdministrator(page);
  const companyUrl = `/companies/${companyId}`;

  const refusedDeletion = await page.request.post(`${companyUrl}/delete`, {
    data: { exportId: "00000000-0000-4000-8000-000000000000" },
  });
  expect(refusedDeletion.status()).toBe(422);
  expect(await refusedDeletion.json()).toEqual({ error: "export_required" });

  await page.goto(`${companyUrl}/settings`);
  const download = page.waitForEvent("download");
  const response = page.waitForResponse((candidate) =>
    candidate.request().method() === "POST" && candidate.url().endsWith("/export")
  );
  await page.getByRole("button", { name: "Download Company data" }).click();
  const [archive, exported] = await Promise.all([download, response]);
  expect(archive.suggestedFilename()).toMatch(/^iVAT-company-.*\.zip$/);
  expect(exported.ok()).toBe(true);
  await expect(page).toHaveURL(`${companyUrl}/settings`);
  await expect(page.getByText("The Company remains active.")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Company settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export and delete Company" })).toBeVisible();
});
