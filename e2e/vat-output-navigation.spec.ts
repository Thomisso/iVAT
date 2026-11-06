import { readFile } from "node:fs/promises";
import { provisionAndLogIn } from "./support/accounts";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const password = "Playwright-password-85";

async function pdfText(bytes: Uint8Array) {
  const task = getDocument({ data: Uint8Array.from(bytes) });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const content = await (await pdf.getPage(pageNumber)).getTextContent();
    pages.push(
      content.items
        .flatMap((item) => ("str" in item ? [item.str] : []))
        .join(" "),
    );
  }
  await task.destroy();
  return pages.join("\n");
}

async function setLocale(
  context: BrowserContext,
  baseURL: string | undefined,
  locale: "cs" | "en",
) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([
    { name: "NEXT_LOCALE", value: locale, url: new URL(baseURL).origin },
  ]);
}

async function createCompany(page: Page) {
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ico = `${Date.now()}`.slice(-8);
  const companyName = `Output Company ${run}`;
  await provisionAndLogIn(page, { organizationName: `Output Organization ${run}`, email: `outputs-${run}@example.test`, password });
  await page.getByLabel("Company name").fill(companyName);
  await page.getByLabel("IČO").fill(ico);
  await page.getByLabel("VAT ID").fill(`CZ${ico}`);
  await page.getByLabel("Street name").fill("Na Příkopě");
  await page.getByLabel("House number").fill("1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/setup\/ai-processing$/);
  await page.getByRole("link", { name: "Continue to Company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+$/);
  return {
    companyId: new URL(page.url()).pathname.split("/")[2],
    companyName,
  };
}

test("empty and draft Reporting Periods expose separate statutory destinations in both locales", async ({
  baseURL,
  context,
  page,
}) => {
  await setLocale(context, baseURL, "en");
  const { companyId, companyName } = await createCompany(page);
  const processingUrl = `/companies/${companyId}/vat-reports?period=2026-01`;
  await page.goto(processingUrl);

  const emptyNavigation = page.getByRole("navigation", {
    name: "Reporting Period destinations",
  });
  await expect(emptyNavigation.getByRole("link", { name: "Processing" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(emptyNavigation.getByText("VAT Return", { exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByText("No saved VAT Report", { exact: true })).toBeVisible();
  const unavailable = await page.goto(
    `/companies/${companyId}/vat-reports/2026-01/vat-return`,
  );
  expect(unavailable?.status()).toBe(404);

  await page.goto(processingUrl);
  await page.getByRole("button", { name: "Generate draft" }).click();
  const draftNavigation = page.getByRole("navigation", {
    name: "Reporting Period destinations",
  });
  await expect(draftNavigation.getByRole("link")).toHaveCount(4);
  await draftNavigation.getByRole("link", { name: "VAT Return" }).click();
  const processingOrigin = `${processingUrl}#vat-step-outputs`;
  await expect(page).toHaveURL((url) => url.pathname === `/companies/${companyId}/vat-reports/2026-01/vat-return` && url.searchParams.size === 1 && url.searchParams.get("returnTo") === processingOrigin);
  await expect(page).toHaveTitle("VAT Return · 2026-01");
  await expect(page.getByText(`${companyName} · 2026-01`, { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "VAT Return" })).toBeVisible();
  await expect(page.locator('input[name="format"]')).toHaveValue("dphdp3");
  await expect(page.locator('select[name="format"]')).toHaveCount(0);
  const order = await page.evaluate(() => {
    const issues = document.querySelector(".vat-output-issues");
    const actions = document.querySelector(".vat-output-actions");
    return !!issues && !!actions && Boolean(issues.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);

  await page
    .getByRole("navigation", { name: "Reporting Period destinations" })
    .getByRole("link", { name: "Control Statement" })
    .click();
  await expect(page).toHaveURL((url) => url.pathname === `/companies/${companyId}/vat-reports/2026-01/control-statement` && url.searchParams.size === 1 && url.searchParams.get("returnTo") === processingOrigin);
  await expect(page).toHaveTitle("Control Statement · 2026-01");
  await expect(page.getByRole("heading", { name: "Control Statement · 2026-01" })).toBeVisible();
  await expect(page.locator('input[name="format"]')).toHaveValue("dphkh1");
  await expect(page.locator('select[name="format"]')).toHaveCount(0);
  const pdfDownload = page.getByRole("link", {
    name: "Download Control Statement PDF",
  });
  const pdfPath = `/companies/${companyId}/vat-reports/2026-01/control-statement/pdf`;
  await expect(pdfDownload).toHaveAttribute("href", pdfPath);
  await expect(pdfDownload).toHaveAttribute("download", "DPHKH1-2026-01.pdf");
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const pdfResponse = await context.request.get(new URL(pdfPath, baseURL).toString());
  expect(pdfResponse.status()).toBe(200);
  expect(pdfResponse.headers()["content-type"]).toBe("application/pdf");
  expect(pdfResponse.headers()["content-disposition"]).toBe(
    'attachment; filename="DPHKH1-2026-01.pdf"',
  );
  const englishPdf = await pdfResponse.body();
  expect(englishPdf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(await pdfText(englishPdf)).toContain(
    "iVAT · Control Statement preview",
  );

  await page
    .getByRole("navigation", { name: "Reporting Period destinations" })
    .getByRole("link", { name: "Export history" })
    .click();
  await expect(page).toHaveURL((url) => url.pathname === `/companies/${companyId}/vat-reports/2026-01/exports` && url.searchParams.size === 1 && url.searchParams.get("returnTo") === processingOrigin);
  await expect(page.getByText("No stored export artifacts", { exact: true })).toBeVisible();

  await setLocale(context, baseURL, "cs");
  const czechPdfResponse = await context.request.get(
    new URL(pdfPath, baseURL).toString(),
  );
  expect(czechPdfResponse.status()).toBe(200);
  const czechPdf = await pdfText(await czechPdfResponse.body());
  expect(czechPdf).toContain("iVAT · Náhled kontrolního hlášení");
  expect(czechPdf).toContain("Zdaňovací období: 2026-01");
  expect(czechPdf).not.toContain("Reporting Period");
  await page.reload();
  await expect(page).toHaveTitle("Historie exportů · 2026-01");
  const czechNavigation = page.getByRole("navigation", {
    name: "Části zdaňovacího období",
  });
  await expect(czechNavigation.getByRole("link")).toHaveCount(4);
  await expect(czechNavigation.getByRole("link", { name: "Zpracování" })).toBeVisible();
  await expect(czechNavigation.getByRole("link", { name: "Přiznání k DPH" })).toBeVisible();
  await expect(czechNavigation.getByRole("link", { name: "Kontrolní hlášení" })).toBeVisible();
  await expect(czechNavigation.getByRole("link", { name: "Historie exportů" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});


test("both statutory downloads use current export edits and leave Company defaults unchanged", async ({ page, context, baseURL }, testInfo) => {
  await setLocale(context, baseURL, "en");
  const { companyId } = await createCompany(page);
  await page.goto(`/companies/${companyId}/settings/vat`);
  await page.getByRole("combobox", { name: "Tax office", exact: true }).selectOption("451");
  await page.getByLabel("Economic activity (CZ-NACE)").fill("621000");
  await page.getByLabel("First name").fill("Jana");
  await page.getByLabel("Last name").fill("Nováková");
  await page.getByLabel("Capacity (e.g. director)").fill("jednatelka");
  await page.getByLabel("Taxpayer email (optional)").fill("default@example.test");
  await page.getByLabel("Taxpayer phone (optional)").fill("+420123456789");
  await page.getByRole("button", { name: "Save filing defaults" }).click();
  await expect(page.getByRole("status").getByText("Filing defaults saved.")).toBeVisible();
  await page.goto(`/companies/${companyId}/vat-reports?period=2026-01`);
  await page.getByRole("button", { name: "Generate draft", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Reporting Period destinations" }).getByRole("link", { name: "VAT Return", exact: true })).toBeVisible();
  const longEmailDomain = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}`;
  for (const [destination, format, date, email, pdfLabel] of [
    ["vat-return", "dphdp3", "04.11.2026", `${"v".repeat(64)}@${longEmailDomain}`, "Download VAT Return PDF"],
    ["control-statement", "dphkh1", "05.11.2026", `${"c".repeat(64)}@${longEmailDomain}`, "Download Control Statement PDF"],
  ]) {
    await page.goto(`/companies/${companyId}/vat-reports/2026-01/${destination}`);
    await page.getByLabel("Preparation date", { exact: true }).fill(date);
    await page.getByRole("button", { name: "Edit for this export" }).click();
    await page.getByLabel("Contact email (optional)").fill(email);
    await page.getByLabel("Contact phone (optional)").fill("");
    const pdfDownload = page.waitForEvent("download");
    await page.getByRole("link", { name: pdfLabel, exact: true }).click();
    const downloadedPdf = await pdfDownload;
    await downloadedPdf.saveAs(testInfo.outputPath(`${format}.pdf`));
    const pdfPath = await downloadedPdf.path();
    if (!pdfPath) throw new Error("PDF did not download");
    const pdf = await pdfText(await readFile(pdfPath));
    expect(pdf).toContain(date);
    expect(pdf.replace(/\s/g, "")).toContain(email);
    expect(pdf).not.toContain("default@example.test");
    expect(pdf).not.toContain("+420123456789");
    const xmlDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download XML", exact: true }).click();
    const xmlPath = await (await xmlDownload).path();
    if (!xmlPath) throw new Error("XML did not download");
    const xml = await readFile(xmlPath, "utf8");
    expect(xml).toContain(`d_poddp="${date}"`);
    expect(xml).toContain(`email="${email}"`);
    expect(xml).not.toContain("c_telef=");
    expect((await page.request.post(`/companies/${companyId}/vat-reports/2026-01/xml`, { form: { format, preparedOn: "2026-11-04", taxOffice: "" } })).status()).toBe(422);
  }
  await page.goto(`/companies/${companyId}/settings/vat`);
  await expect(page.getByLabel("Taxpayer email (optional)")).toHaveValue("default@example.test");
  await expect(page.getByLabel("Taxpayer phone (optional)")).toHaveValue("+420123456789");
});
