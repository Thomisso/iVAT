import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext } from "@playwright/test";

async function setLocale(
  context: BrowserContext,
  baseURL: string | undefined,
  value: "cs" | "en",
) {
  if (!baseURL) throw new Error("Playwright baseURL is required for prototype locale tests");
  await context.addCookies([{ name: "NEXT_LOCALE", value, url: new URL(baseURL).origin }]);
}

const widths = [360, 720, 1024, 1440];
const screens = [
  "overview",
  "upload",
  "documents",
  "review",
  "vat",
  "vat-output",
  "vat-statement",
  "settings",
];

for (const width of widths) {
  for (const screen of screens) {
    test(`${screen} composes without horizontal page overflow at ${width} CSS px`, async ({ baseURL, context, page }) => {
      await setLocale(context, baseURL, "en");
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/prototype?screen=${screen}`);

      await expect(page.getByRole("navigation", { name: "Company navigation" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }
}

test("prototype has visible keyboard focus and stops processing motion when requested", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "en");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/prototype?screen=overview");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();

  const animatedBar = page.getByRole("status").filter({ hasText: "AI processing" }).locator("div[aria-hidden=true] > span");
  await expect(animatedBar).toHaveCSS("animation-name", "none");
});

test("the skip link bypasses Company navigation and continues within main content", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "en");
  await page.goto("/prototype?screen=overview");

  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main-content")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Add Source Files" })).toBeFocused();
});

test("Overview primary action keeps white-on-blue contrast", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "en");
  await page.goto("/prototype?screen=overview");

  const action = page.getByRole("link", { name: "Add Source Files" });
  await expect(action).toHaveCSS("background-color", "rgb(33, 98, 143)");
  await expect(action).toHaveCSS("color", "rgb(255, 255, 255)");
  const results = await new AxeBuilder({ page })
    .include('a[href="/prototype?screen=upload"]')
    .withRules(["color-contrast"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("inactive ledger stages keep neutral text contrast at mobile and desktop widths", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "en");

  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/prototype?screen=overview");
    const inactiveMarkers = page.getByRole("list", { name: "Document processing path" }).locator("li:nth-child(n+3) > span:first-child");
    await expect(inactiveMarkers).toHaveCount(2);
    for (const marker of await inactiveMarkers.all()) {
      await expect(marker).toHaveCSS("color", "rgb(92, 107, 114)");
      await expect(marker).toHaveCSS("background-color", "rgb(243, 245, 243)");
    }
    const results = await new AxeBuilder({ page })
      .include('ol[aria-label="Document processing path"] li:nth-child(n+3)')
      .withRules(["color-contrast"])
      .analyze();
    expect(results.violations, `${width}px inactive ledger contrast`).toEqual([]);
  }
});

test("structural counts and human capture controls do not use the AI ochre accent", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "en");
  await page.goto("/prototype?screen=upload");

  const documentCount = page.locator('nav a[href="/prototype?screen=documents"] small');
  await expect(documentCount).toHaveCSS("background-color", "rgb(231, 236, 235)");
  await expect(documentCount).toHaveCSS("color", "rgb(69, 84, 92)");
  const captureIcon = page.getByRole("heading", { name: "Add Source Files" }).locator("xpath=../preceding-sibling::span");
  await expect(captureIcon).toHaveCSS("color", "rgb(154, 201, 229)");

  await page.goto("/prototype?screen=documents");
  const queueCount = page.getByRole("button", { name: /Needs review/ }).locator("span");
  await expect(queueCount).toHaveCSS("background-color", "rgb(230, 240, 246)");
  await expect(queueCount).toHaveCSS("color", "rgb(33, 98, 143)");
});

test("Documents and review have no axe violations at desktop width", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "en");
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const screen of ["documents", "review"]) {
    await page.goto(`/prototype?screen=${screen}`);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, `${screen} accessibility violations`).toEqual([]);
  }
});

test("mobile VAT Return exposes its scroll region and keeps blocked finalization unavailable", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "en");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/prototype?screen=vat-output");

  await expect(page.getByRole("region", { name: "VAT Return lines" })).toHaveAttribute("tabindex", "0");
  await expect(page.getByRole("button", { name: "Finalize and create final XML" })).toBeDisabled();
});

test("the Company chooser is keyboard operable and preserves Company identity on mobile review", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "en");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/prototype?screen=review");

  const chooser = page.getByRole("button", { name: /Choose Company.*Ateliér Novák s\.r\.o\./ });
  await expect(chooser).toBeVisible();
  await expect(chooser).toContainText("Ateliér Novák s.r.o.");
  await chooser.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu", { name: "Companies" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Ateliér Novák s.r.o. (current)" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Companies" })).toBeHidden();
  await expect(chooser).toBeFocused();
});

test("the Company menu supports traversal, selection, and Tab dismissal", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "en");
  await page.goto("/prototype?screen=overview");

  const chooser = page.getByRole("button", { name: /Choose Company/ });
  await chooser.focus();
  await page.keyboard.press("ArrowDown");
  const current = page.getByRole("menuitem", { name: "Ateliér Novák s.r.o. (current)" });
  const other = page.getByRole("menuitem", { name: "Dvořák Studio s.r.o." });
  await expect(current).toBeFocused();
  const menuAudit = await new AxeBuilder({ page }).include('[role="menu"]').analyze();
  expect(menuAudit.violations).toEqual([]);

  await page.keyboard.press("ArrowUp");
  await expect(other).toBeFocused();
  await page.keyboard.press("Home");
  await expect(current).toBeFocused();
  await page.keyboard.press("End");
  await expect(other).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu", { name: "Companies" })).toBeHidden();
  await expect(chooser).toBeFocused();
  await expect(chooser).toContainText("Dvořák Studio s.r.o.");

  await page.keyboard.press("Space");
  await expect(other).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitem", { name: "Ateliér Novák s.r.o.", exact: true })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(chooser).toContainText("Ateliér Novák s.r.o.");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu", { name: "Companies" })).toBeHidden();
  await expect(page.getByRole("link", { name: "Overview", exact: true })).toBeFocused();
});

test("statutory output scrollers have a visible keyboard focus treatment", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "en");
  await page.setViewportSize({ width: 360, height: 800 });

  for (const [screen, name] of [["vat-output", "VAT Return lines"], ["vat-statement", "Control Statement sections"]]) {
    await page.goto(`/prototype?screen=${screen}`);
    const scroller = page.getByRole("region", { name });
    await scroller.focus();
    await expect(scroller).toBeFocused();
    await expect(scroller).toHaveCSS("outline-color", "rgb(33, 98, 143)");
    await expect(scroller).toHaveCSS("outline-style", "solid");
    await expect(scroller).toHaveCSS("outline-width", "3px");
  }
});

test("mobile capture shows photo controls before an active batch and keeps the human action blue", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "en");
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/prototype?screen=upload");

  const preview = page.getByRole("region", { name: "Photo preview" });
  await expect(preview).toContainText("receipt_2026-10-28.jpg");
  await expect(preview.getByRole("button", { name: "Remove photo" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Retake photo" })).toBeVisible();
  const batch = page.getByRole("status").filter({ hasText: "October receipts" });
  expect(await preview.evaluate((node, other) => Boolean(node.compareDocumentPosition(other as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await batch.elementHandle())).toBe(true);
  await expect(page.getByRole("button", { name: "Take document photo" })).toHaveCSS("background-color", "rgb(33, 98, 143)");
});

test("Control Statement has its own destination and output", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "en");
  await page.goto("/prototype?screen=vat-output");

  const statement = page.getByRole("link", { name: "Control Statement" });
  await expect(statement).toHaveAttribute("href", "/prototype?screen=vat-statement");
  await statement.click();
  await expect(page).toHaveURL(/screen=vat-statement/);
  await expect(page.getByRole("heading", { name: "Control Statement · September 2026" })).toBeVisible();
  await expect(page.getByText("DRAFT_DPHKH1_2026-09.xml")).toBeVisible();
});

test("Czech Upload and English review preserve the same workflow", async ({ baseURL, context, page }) => {
  await setLocale(context, baseURL, "cs");
  await page.goto("/prototype?screen=upload");
  await expect(page.getByRole("button", { name: "Vyfotit doklad" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Probíhá vytěžení" })).toBeVisible();

  await setLocale(context, baseURL, "en");
  await page.goto("/prototype?screen=review");
  await expect(page.getByRole("button", { name: "Approve document" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next document" })).toBeVisible();
});
