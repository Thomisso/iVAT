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
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Output Organization ${run}`);
  await page.getByLabel("Email").fill(`outputs-${run}@example.test`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Company name").fill(companyName);
  await page.getByLabel("IČO").fill(ico);
  await page.getByLabel("VAT ID").fill(`CZ${ico}`);
  await page.getByLabel("Street name").fill("Na Příkopě");
  await page.getByLabel("House number").fill("1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await page.getByLabel("Effective from").fill("2026-01-01");
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
  await expect(page).toHaveURL(
    new RegExp(`/companies/${companyId}/vat-reports/2026-01/vat-return$`),
  );
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
  await expect(page).toHaveURL(
    new RegExp(`/companies/${companyId}/vat-reports/2026-01/control-statement$`),
  );
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
