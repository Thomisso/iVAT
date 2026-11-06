import fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { controlStatementBrowserFixture } from "../tests/support/control-statement-browser";

test("saved Control Statement groups match HTML and PDF, with original Document drill-down", async ({ baseURL, context, page }) => {
  if (!baseURL) throw new Error("Browser base URL missing");
  const fixture = await controlStatementBrowserFixture();
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile("test-results/control-statement-fixture.json", JSON.stringify(fixture), { mode: 0o600 });
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
  const output = `/companies/${fixture.companyId}/vat-reports/2026-10/control-statement`;
  for (const locale of ["en", "cs"] as const) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: new URL(baseURL).origin }]);
    await page.goto(output);
    const label = locale === "en" ? "Section" : "Oddíl";
    await expect(page.getByRole("heading", { level: 3, name: new RegExp(`^${label} `) })).toHaveText([`${label} A.4`, `${label} A.5`, `${label} B.3`]);
    const a4 = page.getByRole("table", { name: `${label} A.4`, exact: true });
    await expect(a4).toHaveCount(1);
    await expect(a4.getByRole("row")).toHaveCount(3);
    await expect(a4.getByText("GROUP-A4-ONE", { exact: true }).first()).toBeVisible();
    await expect(a4.getByText("GROUP-A4-TWO", { exact: true }).first()).toBeVisible();
    const totals = page.getByLabel(locale === "en" ? "Section A.4 · Section totals" : "Oddíl A.4 · Součty oddílu", { exact: true });
    await expect(totals).toContainText(locale === "en" ? "30,000.00" : /30\s000,00/);
    await expect(totals).toContainText(locale === "en" ? "6,300.00" : /6\s300,00/);
    for (const width of [360, 720, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    const response = await page.request.get(`${output}/pdf`);
    expect(response.ok()).toBeTruthy();
    const bytes = await response.body();
    await fs.writeFile(`test-results/control-statement-${locale}.pdf`, bytes);
    const task = getDocument({ data: new Uint8Array(bytes) });
    const pdf = await task.promise;
    const text: string[] = [];
    for (let index = 1; index <= pdf.numPages; index++) text.push((await (await pdf.getPage(index)).getTextContent()).items.flatMap(item => "str" in item ? [item.str] : []).join(" "));
    await task.destroy();
    expect(text).toHaveLength(3);
    expect(text[1].replace(/\s/g, "")).toContain("A.4.");
    for (const literal of ["GROUP-A4-ONE", "GROUP-A4-TWO", "10000.00", "2100.00", "20000.00", "4200.00"]) expect(text[1]).toContain(literal);
    for (const literal of ["200.00", "42.00", "2000.00", "420.00", "30200.00"]) expect(text[2]).toContain(literal);
    expect(text.join(" ")).not.toContain("Section");
  }
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  await page.goto(output);
  const amounts = page.getByRole("table", { name: "Section A.4", exact: true }).getByRole("row").filter({ hasText: "GROUP-A4-ONE" }).locator("summary");
  await amounts.first().click();
  const documentLink = page.getByRole("link", { name: "GROUP-A4-ONE", exact: true });
  await expect(documentLink).toHaveAttribute("href", /returnTo=.*control-entry-/);
  await documentLink.click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+\?returnTo=/);
  await expect(page.getByRole("heading", { name: "Document review GROUP-A4-ONE", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "← Back to Control Statement", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === output && Boolean(url.hash));
  await expect(page.locator(new URL(page.url()).hash)).toContainText("GROUP-A4-ONE");
});
