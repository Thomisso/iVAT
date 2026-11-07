import { expect, test } from "@playwright/test";
import { provisionAndLogIn } from "./support/accounts";
import { addBrowserSourceEvidenceFixture } from "../tests/support/e2e";

test("a source occurrence on the second PDF page stays selected through field focus and Inspect", async ({ page, context, baseURL }, testInfo) => {
  if (!baseURL) throw new Error("Browser base URL required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await provisionAndLogIn(page, { organizationName: `Evidence ${run}`, email: `evidence-${run}@example.test`, password: "Browser-evidence-239" });
  await page.getByLabel("Company name").fill(`Evidence ${run}`);
  await page.getByLabel("IČO").fill("25596641");
  await page.getByLabel("VAT ID").fill("CZ25596641");
  await page.getByLabel("Street name").fill("Vinohradská");
  await page.getByLabel("House number").fill("12");
  await page.getByLabel("City", { exact: true }).fill("Praha");
  await page.getByLabel("Postal code", { exact: true }).fill("12000");
  await page.getByRole("button", { name: "Create company", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await expect(page).toHaveURL(/\/setup\/ai-processing$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];
  const documentId = await addBrowserSourceEvidenceFixture({ companyId, cookies: await context.cookies() });
  await page.goto(`/companies/${companyId}/documents/${documentId}`);
  const canvas = page.locator(".pdf-source-page > canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await page.getByLabel("Original page", { exact: true }).selectOption("3");
  const originalPage = page.locator(".pdf-source-page");
  await expect(originalPage).toHaveAttribute("data-original-page", "3");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  const occurrence = page.locator('[data-source-region="documentNumber"]');
  await page.getByLabel("Zoom", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(occurrence).toBeFocused();
  await expect(occurrence).toHaveCSS("outline-width", "3px");
  await expect(occurrence).toHaveCSS("outline-offset", "3px");
  await page.screenshot({ path: testInfo.outputPath("source-page3-keyboard.png") });
  await occurrence.click();
  await expect(page.getByLabel("Document number", { exact: true })).toBeFocused();
  // Source-to-field focus must preserve this occurrence, rather than opening
  // the first location for the same field on original page 2.
  await expect(originalPage).toHaveAttribute("data-original-page", "3");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  const crop = page.locator("[data-source-inspect-crop] canvas");
  await expect(crop).toBeVisible();
  await expect(originalPage).toHaveAttribute("data-original-page", "3");
  expect(await crop.evaluate((element: HTMLCanvasElement) => {
    const data = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
    let printedPixels = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) printedPixels++;
    return printedPixels;
  })).toBeGreaterThan(20);
  await page.keyboard.press("Escape");
  await expect(crop).toHaveCount(0);
  for (const zoom of ["1", "2"]) {
    await page.getByLabel("Zoom", { exact: true }).selectOption(zoom);
    await page.setViewportSize({ width: zoom === "1" ? 1280 : 1366, height: 900 });
    await expect(canvas).toHaveAttribute("data-ready", "true");
    const rectangle = await occurrence.evaluate((element) => {
      const region = element.getBoundingClientRect();
      const basis = element.parentElement!.getBoundingClientRect();
      return { x: (region.left - basis.left) / basis.width, y: (region.top - basis.top) / basis.height,
        width: region.width / basis.width, height: region.height / basis.height };
    });
    expect(rectangle.x).toBeCloseTo(0.2, 3);
    expect(rectangle.y).toBeCloseTo(0.2, 3);
    expect(rectangle.width).toBeCloseTo(0.4, 3);
    expect(rectangle.height).toBeCloseTo(0.07, 3);
  }
  await page.screenshot({ path: testInfo.outputPath("source-page3-zoom-resize.png") });
  // The opposite direction deliberately selects the field's first location.
  await page.locator('[data-source-field="documentNumber"] .source-field-link').click();
  await expect(originalPage).toHaveAttribute("data-original-page", "2");
  const recordedContent = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname.endsWith(`/documents/${documentId}/content`) && url.searchParams.get("version") === "1";
  });
  await page.goto(`/companies/${companyId}/documents/${documentId}?version=1`);
  expect((await recordedContent).status()).toBe(200);
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await expect(page.getByLabel("Document number", { exact: true })).toBeDisabled();
});

test("a split PDF remains previewable before its first Extraction Version exists", async ({ page, context, baseURL }, testInfo) => {
  if (!baseURL) throw new Error("Browser base URL required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await provisionAndLogIn(page, { organizationName: `Evidence ${run}`, email: `evidence-${run}@example.test`, password: "Browser-evidence-239" });
  await page.getByLabel("Company name").fill(`Evidence ${run}`);
  await page.getByLabel("IČO").fill("25596641");
  await page.getByLabel("VAT ID").fill("CZ25596641");
  await page.getByLabel("Street name").fill("Vinohradská");
  await page.getByLabel("House number").fill("12");
  await page.getByLabel("City", { exact: true }).fill("Praha");
  await page.getByLabel("Postal code", { exact: true }).fill("12000");
  await page.getByRole("button", { name: "Create company", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await expect(page).toHaveURL(/\/setup\/ai-processing$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];
  const documentId = await addBrowserSourceEvidenceFixture({ companyId, cookies: await context.cookies(), withoutExtraction: true });
  const contentRequests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.endsWith(`/documents/${documentId}/content`)) contentRequests.push(request.url()); });
  await page.goto(`/companies/${companyId}/documents/${documentId}`);
  const canvas = page.locator(".pdf-source-page > canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".pdf-source-page")).toHaveAttribute("data-original-page", "2");
  expect(contentRequests.length).toBeGreaterThan(0);
  expect(contentRequests.every(url => !new URL(url).searchParams.has("version"))).toBe(true);
  await expect(page.getByRole("button", { name: "Inspect", exact: true })).toBeDisabled();
  await expect(page.locator("[data-source-region]")).toHaveCount(0);
  await page.getByLabel("Original page", { exact: true }).selectOption("3");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".pdf-source-page")).toHaveAttribute("data-original-page", "3");
  await page.screenshot({ path: testInfo.outputPath("source-before-first-extraction.png") });
});
