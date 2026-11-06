import fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { controlStatementBrowserFixture } from "../tests/support/control-statement-browser";

async function decode(bytes: Uint8Array) {
  const task = getDocument({ data: Uint8Array.from(bytes) });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let number = 1; number <= pdf.numPages; number++) pages.push((await (await pdf.getPage(number)).getTextContent()).items.flatMap(item => "str" in item ? [item.str] : []).join(" "));
  await task.destroy();
  return pages;
}

test("green Control Statement card independently previews current headers and downloads complete Czech forms in both locales", async ({ page, context, baseURL }, testInfo) => {
  if (!baseURL) throw new Error("Browser base URL missing");
  const fixture = await controlStatementBrowserFixture(33);
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
  const output = `/companies/${fixture.companyId}/vat-reports/2026-10/control-statement`;
  const requests: string[] = [];
  page.on("request", request => { if (request.url().includes(output)) requests.push(new URL(request.url()).pathname); });
  const initialPreview = page.waitForResponse(response => response.url().endsWith(`${output}/thumbnail`) && response.status() === 200);
  await page.goto(output);
  const preview = await initialPreview;
  expect(preview.headers()["cache-control"]).toBe("private, no-store");
  expect(await decode(await preview.body())).toHaveLength(1);
  const canvas = page.locator(".vat-export-card canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  expect(requests).not.toContain(`${output}/pdf`);
  expect(requests.filter(path => path.endsWith("/xml"))).toEqual([]);
  const green = await canvas.evaluate(node => Array.from((node as HTMLCanvasElement).getContext("2d")!.getImageData(8, 8, 1, 1).data));
  expect(green).toEqual([191, 255, 191, 255]);
  await expect(page.locator('input[name="format"]')).toHaveValue("dphkh1");
  expect((await page.request.post(`/companies/${fixture.companyId}/vat-reports/2026-10/xml`, { form: { format: "dphkh1", preparedOn: "2026-11-05", taxOffice: "" } })).status()).toBe(422);

  for (const locale of ["en", "cs"] as const) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL }]);
    await page.goto(output);
    const downloadLabel = locale === "en" ? "Download Control Statement PDF" : "Stáhnout PDF kontrolního hlášení";
    const dateLabel = locale === "en" ? "Preparation date" : "Datum vyhotovení";
    await page.getByLabel(dateLabel, { exact: true }).fill("05.11.2026");
    await page.getByRole("button", { name: locale === "en" ? "Edit for this export" : "Upravit pro tento export" }).click();
    const currentPreview = page.waitForResponse(response => response.url().endsWith(`${output}/thumbnail`) && response.request().postData()?.includes("one-export@example.test") === true);
    await page.getByLabel(locale === "en" ? "Contact email (optional)" : "Kontaktní e-mail (nepovinný)").fill("one-export@example.test");
    const current = await currentPreview;
    const header = await decode(await current.body());
    expect(header).toHaveLength(1);
    expect(header[0]).toContain("one-export@example.test");
    expect(header[0].replace(/\s/g, "")).toContain("05112026");
    await expect(canvas).toHaveAttribute("data-ready", "true");
    if (locale === "en") {
      let release!: () => void;
      let captured!: () => void;
      let completed!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const received = new Promise<void>(resolve => { captured = resolve; });
      const settled = new Promise<void>(resolve => { completed = resolve; });
      await page.route(`**${output}/thumbnail`, async route => {
        if (!route.request().postData()?.includes("stale@example.test")) { await route.continue(); return; }
        try {
          const response = await route.fetch();
          captured();
          await held;
          await route.fulfill({ response });
        } catch { /* The obsolete request is allowed to be aborted. */ }
        finally { completed(); }
      });
      const emailInput = page.getByLabel("Contact email (optional)");
      await emailInput.fill("stale@example.test");
      await received;
      const latest = page.waitForResponse(response => response.url().endsWith(`${output}/thumbnail`) && response.request().postData()?.includes("one-export@example.test") === true);
      await emailInput.fill("one-export@example.test");
      await latest;
      await expect(canvas).toHaveAttribute("data-ready", "true");
      const pixels = await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL());
      release();
      await settled;
      expect(await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL())).toBe(pixels);
      await page.unroute(`**${output}/thumbnail`);
    }
    for (const width of [360, 720, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const size = await page.locator(".vat-pdf-thumbnail-link").evaluate(link => {
        const card = link.closest(".vat-export-card")!;
        const style = getComputedStyle(card);
        return { thumbnail: link.getBoundingClientRect().width, content: card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
      });
      expect(size.thumbnail).toBeCloseTo(size.content, 0);
    }
    const thumbnailLink = page.locator(".vat-pdf-thumbnail-link");
    const originalControl = page.getByRole("link", { name: downloadLabel, exact: true });
    await originalControl.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(thumbnailLink).toBeFocused();
    expect(await thumbnailLink.evaluate(link => {
      const style = getComputedStyle(link);
      return { color: style.outlineColor, width: style.outlineWidth, offset: style.outlineOffset, style: style.outlineStyle };
    })).toEqual({ color: "rgb(31, 95, 139)", width: "3px", offset: "3px", style: "solid" });
    await page.keyboard.press("Tab");
    await expect(originalControl).toBeFocused();
    for (const [pathName, selector] of [["thumbnail", page.locator(".vat-pdf-thumbnail-link")], ["control", page.getByRole("link", { name: downloadLabel, exact: true })]] as const) {
      const download = page.waitForEvent("download");
      await selector.click();
      const file = await download;
      expect(file.suggestedFilename()).toBe("DPHKH1-2026-10.pdf");
      const path = testInfo.outputPath(`control-statement-${locale}-${pathName}.pdf`);
      await file.saveAs(path);
      const decoded = await decode(await fs.readFile(path));
      expect(decoded).toHaveLength(4);
      expect(decoded[0]).toContain("one-export@example.test");
      expect(decoded[0].replace(/\s/g, "")).toContain("KONTROLNÍHLÁŠENÍ");
      for (let index = 1; index <= 33; index++) expect(decoded.join(" ").match(new RegExp(`CONTINUE-${String(index).padStart(3, "0")}`, "g"))).toHaveLength(1);
      expect(decoded[2].replace(/\s/g, "")).toContain("A.4.");
      expect(decoded.join(" ")).not.toMatch(/V\s*Z\s*O\s*R|Control Statement preview/);
    }
    const xmlDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: locale === "en" ? "Download XML" : "Stáhnout XML", exact: true }).click();
    const xmlPath = await (await xmlDownload).path();
    if (!xmlPath) throw new Error("XML download missing");
    const xml = await fs.readFile(xmlPath, "utf8");
    expect(xml).toContain('d_poddp="05.11.2026"');
    expect(xml).toContain('email="one-export@example.test"');
    await page.locator(".vat-output-actions").screenshot({ path: testInfo.outputPath(`card-${locale}.png`) });
  }
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  await page.goto(`/companies/${fixture.companyId}/settings/vat`);
  await expect(page.getByLabel("Taxpayer email (optional)")).toHaveValue("default@example.test");
  await expect(page.getByLabel("Taxpayer phone (optional)")).toHaveValue("+420123456789");
  const incomplete = await page.request.post(`${output}/thumbnail`, { form: { taxOffice: "", preparedOn: "2026-11-05", email: "available@example.test" } });
  expect(incomplete.status()).toBe(200);
  const [incompleteHeader] = await decode(await incomplete.body());
  expect(incompleteHeader).toContain("available@example.test");
  expect(incompleteHeader).not.toContain("hlavní město Prahu");
  const other = await context.browser()!.newContext();
  const anonymous = await other.request.get(new URL(`${output}/thumbnail`, baseURL).toString(), { maxRedirects: 0 });
  expect([302, 303, 307]).toContain(anonymous.status());
  await other.close();
});
