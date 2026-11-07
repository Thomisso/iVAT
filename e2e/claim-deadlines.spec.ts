import { expect, test } from "@playwright/test";
import { provisionAndLogIn } from "./support/accounts";
import { browserUserClient, withBrowserClaimDate } from "../tests/support/e2e";
import { SAMPLE_EXTRACTION } from "../src/ai/fake";
import { createManualDocument } from "../src/application/documents";
import { setCurrentReportingYear } from "../src/application/companies";
import { fakeVatPayerRegistry } from "../src/vat-registry/fake";

test("review displays the filing cutoff and trusted date, refusing a fresh approval after expiry", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("base URL required");
  await withBrowserClaimDate("2027-12-31", async clock => {
    await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
    const run = crypto.randomUUID();
    await provisionAndLogIn(page, { organizationName: `Deadline ${run}`, email: `deadline-${run}@example.test`, password: "Claim-deadline-browser-238" });
    await page.getByLabel("Company name").fill(`Deadline ${run}`);
    await page.getByLabel("IČO").fill("25596641");
    await page.getByLabel("VAT ID").fill("CZ25596641");
    await page.getByLabel("Street name").fill("Vinohradská");
    await page.getByLabel("House number").fill("12");
    await page.getByLabel("City").fill("Praha");
    await page.getByLabel("Postal code").fill("12000");
    await page.getByRole("button", { name: "Create company", exact: true }).click();
    await page.getByRole("button", { name: "Save and continue", exact: true }).click();
    await expect(page).toHaveURL(/\/setup\/ai-processing$/);
    const companyId = new URL(page.url()).pathname.split("/")[2];
    const client = await browserUserClient(await context.cookies());
    for (const year of [2025, 2027]) expect(await setCurrentReportingYear(client, { companyId, year, filingFrequency: "monthly" })).toEqual({ ok: true, value: null });
    const created = await createManualDocument(client, { companyId, payload: {
      ...SAMPLE_EXTRACTION, taxPointDate: "2025-05-26", issueDate: "2025-05-26",
      claimEligibility: { period: "2025-05", origin: "user", confirmed: true },
    } }, undefined, fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    await page.goto(`/companies/${companyId}/documents/${created.value.id}`);
    await expect(page.getByText("Claim must be exercised by filing no later than: 31.12.2027", { exact: true })).toBeVisible();
    await expect(page.getByText("Assessed as of: 31.12.2027", { exact: true })).toBeVisible();
    await expect(page.getByText("Latest available ordinary period: 2027-11", { exact: true })).toBeVisible();
    await expect(page.locator('select[name="claimedReportingPeriod"] option[value="2027-12"]')).toHaveCount(0);
    await expect(page.getByText("Choose an unlocked later period that can end before the claim filing deadline.", { exact: true })).toBeVisible();
    await clock.setDate("2028-01-01");
    await page.reload();
    await expect(page.getByText("Assessed as of: 01.01.2028", { exact: true })).toBeVisible();
    await expect(page.getByText("The claim filing deadline has expired. A new approval cannot establish timely filing.", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Approve version 1", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The claim filing deadline has expired." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve version 1", exact: true })).toBeEnabled();
  });
});
