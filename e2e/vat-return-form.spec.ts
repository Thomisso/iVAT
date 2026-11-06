import fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { vatReturnBrowserFixture } from "../tests/support/vat-return-browser";

async function readPdf(bytes: Uint8Array) {
  const task = getDocument({ data: Uint8Array.from(bytes) });
  try {
    const document = await task.promise;
    const pages = [];
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      pages.push({ text: content.items.flatMap(item => "str" in item ? [item.str] : []).join(" "), date: content.items.flatMap(item => "str" in item && item.transform[4] >= 49.9 && item.transform[4] < 162.8 && 842 - item.transform[5] >= 727 && 842 - item.transform[5] < 743.5 ? [item.str] : []).join("").replace(/\s/g, "") });
    }
    return pages;
  } finally { await task.destroy(); }
}

test("VAT Return card independently previews current Czech headers and both controls download the complete green form", async ({ page, context, baseURL }, testInfo) => {
  if (!baseURL) throw new Error("Missing base URL");
  const fixture = await vatReturnBrowserFixture();
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile("test-results/vat-return-fixture.json", JSON.stringify(fixture), { mode: 0o600 });
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
  const output = `/companies/${fixture.companyId}/vat-reports/2026-10/vat-return`;
  const fullPath = `/companies/${fixture.companyId}/vat-reports/2026-10/pdf`;
  const requests: string[] = [];
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  for (const locale of ["en", "cs"] as const) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: new URL(baseURL).origin }]);
    const thumbnailResponse = page.waitForResponse(response => response.url().endsWith(`${output}/thumbnail`) && response.request().method() === "POST");
    await page.goto(output);
    const thumbnail = page.locator(".vat-pdf-thumbnail");
    await expect(thumbnail).toHaveAttribute("data-ready", "true");
    const response = await thumbnailResponse;
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    const first = await readPdf(await response.body());
    expect(first).toHaveLength(1);
    expect(first[0].text).toContain("Příliš žluťoučký kůň s.r.o.");
    expect(first[0].text).toContain("P Ř I Z N Á N Í");
    expect(requests).not.toContain(fullPath);
    expect(requests.some(path => path.endsWith("/compute") || path.endsWith("/generate"))).toBe(false);
    for (const width of [360, 720, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    const dateLabel = locale === "en" ? "Preparation date" : "Datum vyhotovení";
    await page.getByLabel(dateLabel, { exact: true }).fill("04.11.2026");
    await page.getByRole("button", { name: locale === "en" ? "Edit for this export" : "Upravit pro tento export" }).click();
    const updatedResponse = page.waitForResponse(response => response.url().endsWith(`${output}/thumbnail`) && response.request().postData()?.includes("one-off@example.test") === true);
    await page.getByLabel(locale === "en" ? "Contact email (optional)" : "Kontaktní e-mail (nepovinný)").fill("one-off@example.test");
    const updated = await updatedResponse;
    const updatedPages = await readPdf(await updated.body());
    expect(updatedPages[0].text).toContain("one-off@example.test");
    expect(updatedPages[0].date).toBe("04112026");
    await expect(thumbnail).toHaveAttribute("data-ready", "true");
    await thumbnail.screenshot({ path: testInfo.outputPath(`vat-thumbnail-${locale}.png`) });
    if (locale === "en") {
      await page.locator(".vat-export-card").first().screenshot({ path: testInfo.outputPath("vat-card-desktop.png") });
      await page.setViewportSize({ width: 360, height: 1000 });
      await page.locator(".vat-export-card").first().screenshot({ path: testInfo.outputPath("vat-card-narrow.png") });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    requests.length = 0;
    for (const locator of [page.locator(".vat-pdf-thumbnail-link"), page.locator(".vat-export-card .iv-btn").first()]) {
      const downloadEvent = page.waitForEvent("download");
      await locator.click();
      const download = await downloadEvent;
      const file = testInfo.outputPath(`vat-${locale}-${requests.length}.pdf`);
      await download.saveAs(file);
      const pages = await readPdf(await fs.readFile(file));
      expect(pages).toHaveLength(2);
      expect(pages[0].text).toContain("one-off@example.test");
      expect(pages[0].date).toBe("04112026");
      expect(pages[1].text).toContain("C. ODDÍL");
    }
    requests.length = 0;
    const xmlEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: locale === "en" ? "Download XML" : "Stáhnout XML", exact: true }).click();
    const xmlPath = await (await xmlEvent).path();
    if (!xmlPath) throw new Error("No XML download");
    const xml = await fs.readFile(xmlPath, "utf8");
    expect(xml).toContain('email="one-off@example.test"');
    expect(xml).toContain('d_poddp="04.11.2026"');
    await page.getByRole("combobox", { name: locale === "en" ? "Tax office" : "Finanční úřad", exact: true }).selectOption("");
    await expect(thumbnail).toHaveAttribute("data-ready", "true");
    expect((await page.request.post(`${output}/thumbnail`, { form: { taxOffice: "", preparedOn: "2026-11-04" } })).status()).toBe(200);
    expect((await page.request.post(`/companies/${fixture.companyId}/vat-reports/2026-10/xml`, { form: { format: "dphdp3", taxOffice: "", preparedOn: "2026-11-04" } })).status()).toBe(422);
    if (locale === "en") {
      let releaseOld!: () => void;
      let oldReady!: () => void;
      let oldFinished!: () => void;
      const held = new Promise<void>(resolve => { releaseOld = resolve; });
      const seen = new Promise<void>(resolve => { oldReady = resolve; });
      const finished = new Promise<void>(resolve => { oldFinished = resolve; });
      await page.route(`**${output}/thumbnail`, async route => {
        if (!route.request().postData()?.includes("superseded@example.test")) { await route.continue(); return; }
        const actual = await route.fetch();
        oldReady();
        await held;
        try { await route.fulfill({ response: actual }); } finally { oldFinished(); }
      });
      await page.getByLabel("Contact email (optional)").fill("superseded@example.test");
      await seen;
      const latest = page.waitForResponse(response => response.url().endsWith(`${output}/thumbnail`) && response.request().postData()?.includes("current@example.test") === true);
      await page.getByLabel("Contact email (optional)").fill("current@example.test");
      expect((await readPdf(await (await latest).body()))[0].text).toContain("current@example.test");
      await expect(thumbnail).toHaveAttribute("data-ready", "true");
      releaseOld();
      await finished;
      await expect(thumbnail).toHaveAttribute("data-ready", "true");
      await page.unroute(`**${output}/thumbnail`);
    }
    requests.length = 0;
  }
  await page.goto(`/companies/${fixture.companyId}/settings/vat`);
  await expect(page.getByLabel("E-mail daňového subjektu (nepovinný)")).toHaveValue("default@example.test");
  expect(browserErrors).toEqual([]);
});
