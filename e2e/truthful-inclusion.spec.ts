import { expect, test } from "@playwright/test";
import { inclusionBrowserFixture } from "../tests/support/inclusion-browser";
import fs from "node:fs/promises";
import * as XLSX from "xlsx";

test("Document detail separates approval from current inclusion and preserves proposed mapping", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("Browser URL missing");
  const fixture = await inclusionBrowserFixture();
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile("test-results/inclusion-fixture.json", JSON.stringify(fixture), { mode: 0o600 });
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
  for (const locale of ["en", "cs"] as const) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL }]);
    const label = locale === "en" ? "Live VAT calculation" : "Živý výpočet DPH";
    const excludedText = locale === "en" ? "Excluded from live calculation" : "Nezahrnuto do živého výpočtu";
    const includedText = locale === "en" ? "Included in live calculation" : "Zahrnuto do živého výpočtu";
    await page.goto(`/companies/${fixture.companyId}/documents/${fixture.excludedId}`);
    const live = page.getByRole("group", { name: label });
    await expect(live).toContainText(excludedText);
    await expect(live).toContainText(locale === "en" ? "A valid counterparty VAT ID is required for reporting." : "Pro zahrnutí je nutné platné DIČ protistrany.");
    await expect(live).toContainText(locale === "en" ? "Proposed mapping — not counted" : "Navržené zařazení — nezapočteno");
    await expect(live).toContainText("40");
    await expect(live).toContainText("B.3");
    await expect(page.getByText("Approved. The document counts towards VAT reports.", { exact: true })).toHaveCount(0);
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `test-results/inclusion-detail-${locale}-${width}.png`, fullPage: true });
    }
    await page.goto(`/companies/${fixture.companyId}/documents?view=all&reportingPeriod=2026-10`);
    await expect(page.locator(`#document-${fixture.excludedId}`)).toContainText(excludedText);
    await expect(page.locator(`#document-${fixture.includedId}`)).toContainText(includedText);
    await page.goto(`/companies/${fixture.companyId}/documents/${fixture.includedId}`);
    await expect(page.getByRole("group", { name: label })).toContainText(includedText);
    await expect(page.getByRole("group", { name: label })).toContainText(locale === "en" ? "Blocking findings: 0 · Advisory findings: 1" : "Blokující nálezy: 0 · Upozornění: 1");
    await page.goto(`/companies/${fixture.companyId}/vat-reports?period=2026-10`);
    await expect(page.getByText(locale === "en" ? "Live calculation: 1 included, 1 excluded." : "Živý výpočet: 1 zahrnuto, 1 nezahrnuto.", { exact: true })).toBeVisible();
    await expect(page.locator(".vat-wizard-documents").getByRole("group", { name: label })).toContainText(excludedText);
    const downloaded = page.waitForEvent("download");
    await page.getByRole("link", { name: locale === "en" ? "Download Excel overview" : "Stáhnout přehled v Excelu", exact: true }).click();
    const download = await downloaded;
    const path = await download.path();
    if (!path) throw new Error("Workbook download missing");
    const workbook = XLSX.readFile(path);
    const included = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Included, { defval: "" });
    const attention = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Attention, { defval: "" });
    expect(included).toContainEqual(expect.objectContaining({ "Document ID": fixture.includedId, "Live inclusion": "included" }));
    expect(attention).toContainEqual(expect.objectContaining({ "Document ID": fixture.includedId, "Live inclusion": "included" }));
    expect(attention).toContainEqual(expect.objectContaining({ "Document ID": fixture.excludedId, "Live inclusion": "excluded", "Exclusion detail": "counterparty_vat_id_required", "VAT Return line": "40", "Control Statement section": "B.3" }));
  }
});
