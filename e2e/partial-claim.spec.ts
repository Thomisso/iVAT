import { expect, test, type Page, type BrowserContext } from "@playwright/test";
import { provisionAndLogIn } from "./support/accounts";
import { browserUserClient } from "../tests/support/e2e";
import { SAMPLE_EXTRACTION } from "../src/ai/fake";
import { createManualDocument, listExtractionVersions } from "../src/application/documents";
import { generateVatReport, getVatReport } from "../src/application/vat-reports";
import { fakeVatPayerRegistry } from "../src/vat-registry/fake";
import type { ExtractionPayload } from "../src/application/extraction-payload";

async function documentForReview(page: Page, context: BrowserContext, baseURL: string | undefined, overrides: Partial<ExtractionPayload> = {}) {
  if (!baseURL) throw new Error("base URL required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = crypto.randomUUID();
  await provisionAndLogIn(page, { organizationName: `Partial ${run}`, email: `partial-${run}@example.test`, password: "Atomic-browser-password-228" });
  await page.getByLabel("Company name").fill(`Partial ${run}`);
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

  const full = { ...SAMPLE_EXTRACTION,
    rateBreakdown: [{ rate: 21, netAmount: "12000.00", vatAmount: "2520.00" }],
    totals: { netAmount: "12000.00", vatAmount: "2520.00", grossAmount: "14520.00" },
    claimEligibility: { period: "2026-10", origin: "user" as const, confirmed: true },
    ...overrides,
  };
  const created = await createManualDocument(client, { companyId, payload: full }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  await page.goto(`/companies/${companyId}/documents/${created.value.id}`);
  return { companyId, client, created, full };
}

test("mixed foreign supplies retain source amounts and an explicit zero choice retains previous report history", async ({ page, context, baseURL }) => {
  const { companyId, client, created } = await documentForReview(page, context, baseURL, {
    currency: "EUR", rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "210.00" }, { rate: 12, netAmount: "1000.00", vatAmount: "120.00" }],
    totals: { netAmount: "2000.00", vatAmount: "330.00", grossAmount: "2330.00" },
  });
  await page.getByRole("checkbox", { name: "Claim selected supplies", exact: true }).check();
  const standard = page.getByRole("group", { name: "Selected supplies at 21%", exact: true });
  const reduced = page.getByRole("group", { name: "Selected supplies at 12%", exact: true });
  await expect(standard.getByLabel("Claimed net", { exact: true })).toHaveValue("1000.00");
  await expect(reduced.getByLabel("Claimed VAT", { exact: true })).toHaveValue("120.00");
  await standard.getByLabel("Claimed net", { exact: true }).fill("333,35");
  await standard.getByLabel("Claimed VAT", { exact: true }).fill("70,00");
  await reduced.getByLabel("Claimed net", { exact: true }).fill("100,05");
  await reduced.getByLabel("Claimed VAT", { exact: true }).fill("12,01");
  const remainder = page.getByRole("region", { name: "Unclaimed Portion", exact: true });
  await expect(remainder).toContainText("666.65");
  await expect(remainder).toContainText("899.95");
  await expect(remainder).toContainText("1814.59 EUR");
  await page.getByRole("button", { name: "Approve version 1", exact: true }).click();
  await expect(page).toHaveURL(/\/documents(?:\?.*)?$/);
  const versions = await listExtractionVersions(client, companyId, created.value.id);
  expect(versions[1].payload.partialClaim?.rateBreakdown).toEqual([
    { rate: 21, netAmount: "333.35", vatAmount: "70.00" }, { rate: 12, netAmount: "100.05", vatAmount: "12.01" },
  ]);
  expect((await generateVatReport(client, { companyId, period: "2026-10" })).ok).toBe(true);
  const saved = await getVatReport(client, companyId, "2026-10");
  expect(saved?.result.vatReturn.filter(line => line.documentIds.length)).toMatchObject([
    { line: "40", netAmount: "8333.75", vatAmount: "1750.00" }, { line: "41", netAmount: "2501.25", vatAmount: "300.25" },
  ]);
  await page.goto(`/companies/${companyId}/documents/${created.value.id}`);
  await page.getByRole("button", { name: "Return to review", exact: true }).click();
  await expect(standard.getByLabel("Claimed net", { exact: true })).toBeEnabled();
  await standard.getByLabel("Claimed net", { exact: true }).fill("0");
  await standard.getByLabel("Claimed VAT", { exact: true }).fill("0");
  await reduced.getByLabel("Claimed net", { exact: true }).fill("0");
  await reduced.getByLabel("Claimed VAT", { exact: true }).fill("0");
  await expect(remainder).toContainText("Cannot calculate");
  await page.getByRole("checkbox", { name: "I confirm no input VAT deduction from this Document.", exact: true }).check();
  await expect(remainder).toContainText("2330.00 EUR");
  await page.getByRole("button", { name: "Approve version 2", exact: true }).click();
  await expect(page).toHaveURL(/\/documents(?:\?.*)?$/);
  expect((await listExtractionVersions(client, companyId, created.value.id))[2].payload.partialClaim).toMatchObject({ confirmed: true, zeroConfirmed: true });
  expect(await getVatReport(client, companyId, "2026-10")).toEqual(saved);
  expect((await generateVatReport(client, { companyId, period: "2026-10" })).ok).toBe(true);
  expect((await getVatReport(client, companyId, "2026-10"))?.result.controlStatement).toEqual([]);
  await page.goto(`/companies/${companyId}/documents/${created.value.id}?version=2`);
  await expect(standard.getByLabel("Claimed net", { exact: true })).toHaveValue("333.35");
  await expect(standard.getByLabel("Claimed net", { exact: true })).toBeDisabled();
});

test("human selection preserves full values from activation through saved approval and B.2 report", async ({ page, context, baseURL }) => {
  const { companyId, client, created, full } = await documentForReview(page, context, baseURL);
  await expect(page.getByRole("region", { name: "Unclaimed Portion", exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Claim selected supplies", exact: true }).check();
  await expect(page.getByLabel("Claimed net", { exact: true })).toHaveValue("12000.00");
  await expect(page.getByLabel("Claimed VAT", { exact: true })).toHaveValue("2520.00");
  await page.getByLabel("Claimed net", { exact: true }).fill("6 000,00");
  await page.getByLabel("Claimed VAT", { exact: true }).fill("1 260,00");
  const remainder = page.getByRole("region", { name: "Unclaimed Portion", exact: true });
  await expect(remainder).toContainText("6000.00");
  await expect(remainder).toContainText("1260.00");
  await expect(remainder).toContainText("7260.00");
  await page.getByLabel("Total net", { exact: true }).fill("11900.00");
  await expect(remainder).toContainText("Cannot calculate");
  await page.getByRole("button", { name: "Approve version 1", exact: true }).click();
  await expect(page.getByLabel("Claimed net", { exact: true })).toHaveValue("6 000,00");
  await expect(page.getByLabel("Total net", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Total net", { exact: true }).fill("12000.00");
  await page.getByLabel("Total incl. VAT", { exact: true }).fill("14521.00");
  await page.getByRole("button", { name: "Confirm selection for these full amounts", exact: true }).click();
  await expect(remainder).toContainText("Cannot calculate");
  await page.getByRole("button", { name: "Approve version 1", exact: true }).click();
  await expect(page.getByRole("status", { name: "Warnings for these submitted values", exact: true })).toBeVisible();
  await expect(page.getByLabel("Claimed net", { exact: true })).toHaveValue("6 000,00");
  await page.getByLabel("Total incl. VAT", { exact: true }).fill("14520.00");
  await page.getByRole("button", { name: "Confirm selection for these full amounts", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve version 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve version 2", exact: true }).click();
  await expect(page).toHaveURL(/\/documents(?:\?.*)?$/);
  const versions = await listExtractionVersions(client, companyId, created.value.id);
  expect(versions[0].payload.partialClaim).toBeUndefined();
  expect(versions[1].payload).toMatchObject({ rateBreakdown: full.rateBreakdown, totals: full.totals,
    partialClaim: { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "6000.00", vatAmount: "1260.00" }] } });
  expect((await generateVatReport(client, { companyId, period: "2026-10" })).ok).toBe(true);
  expect((await getVatReport(client, companyId, "2026-10"))?.result.controlStatement).toMatchObject([
    { section: "B.2", rateBreakdown: [{ netAmount: "6000.00", vatAmount: "1260.00" }] },
  ]);
  await page.goto(`/companies/${companyId}/documents/${created.value.id}`);
  await page.getByText("Version history", { exact: true }).click();
  await page.getByRole("link", { name: "Version 1: FV-2026-0001 (User (you))", exact: true }).click({ timeout: 3_000 });
  await expect(page.getByRole("checkbox", { name: "Claim selected supplies", exact: true })).not.toBeChecked();
  await expect(page.getByRole("region", { name: "Unclaimed Portion", exact: true })).toHaveCount(0);
  await page.getByText("Version history", { exact: true }).click();
  await page.getByRole("link", { name: "Version 2: FV-2026-0001 (User (you))", exact: true }).click({ timeout: 3_000 });
  await expect(page.getByLabel("Claimed net", { exact: true })).toHaveValue("6000.00");
  await expect(page.getByLabel("Claimed net", { exact: true })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Unclaimed Portion", exact: true })).toContainText("7260.00");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "cs", url: baseURL }]);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Uplatnit vybraná plnění", exact: true })).toBeChecked();
  await expect(page.getByRole("region", { name: "Neuplatněná část", exact: true })).toContainText("7260.00");

});


test("a changed single-rate source clears the old remainder and permits explicit rate reconfirmation without losing selection", async ({ page, context, baseURL }) => {
  const { companyId, client, created } = await documentForReview(page, context, baseURL);
  await page.getByRole("checkbox", { name: "Claim selected supplies", exact: true }).check();
  await page.getByLabel("Claimed net", { exact: true }).fill("6000.00");
  await page.getByLabel("Claimed VAT", { exact: true }).fill("1260.00");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve version 2", exact: true })).toBeVisible();
  const remainder = page.getByRole("region", { name: "Unclaimed Portion", exact: true });
  await expect(remainder).toContainText("7260.00");
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(remainder).toContainText("Cannot calculate");
  await expect(page.getByLabel("Claimed net", { exact: true })).toHaveValue("6000.00");
  await page.getByRole("button", { name: "Add rate", exact: true }).click();
  const rates = page.getByRole("group", { name: "Rate breakdown and totals", exact: true });
  await rates.getByRole("textbox", { name: "Rate (%)", exact: true }).fill("12");
  await rates.getByRole("textbox", { name: "Net", exact: true }).fill("12000.00");
  await rates.getByRole("textbox", { name: "VAT", exact: true }).fill("1440.00");
  await page.getByLabel("Total VAT", { exact: true }).fill("1440.00");
  await page.getByLabel("Total incl. VAT", { exact: true }).fill("13440.00");
  await page.getByLabel("Claimed VAT", { exact: true }).fill("720.00");
  await expect(page.getByText("Previously saved selection: 21% · net 6000.00, VAT 1260.00", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm selection at 12% for these full amounts", exact: true }).click();
  await expect(remainder).toContainText("6720.00");
  await expect(page.getByLabel("Claimed net", { exact: true })).toHaveValue("6000.00");
  await expect(page.getByLabel("Claimed VAT", { exact: true })).toHaveValue("720.00");
  await page.getByRole("button", { name: "Approve version 2", exact: true }).click();
  await expect(page).toHaveURL(/\/documents(?:\?.*)?$/);
  const versions = await listExtractionVersions(client, companyId, created.value.id);
  expect(versions[1].payload.partialClaim).toMatchObject({ rateBreakdown: [{ rate: 21, netAmount: "6000.00", vatAmount: "1260.00" }] });
  expect(versions[2].payload.partialClaim).toMatchObject({ confirmed: true, rateBreakdown: [{ rate: 12, netAmount: "6000.00", vatAmount: "720.00" }] });
  expect((await generateVatReport(client, { companyId, period: "2026-10" })).ok).toBe(true);
  expect((await getVatReport(client, companyId, "2026-10"))?.result.vatReturn.find(line => line.line === "41"))
    .toMatchObject({ netAmount: "6000.00", vatAmount: "720.00" });
});
