import { expect, test } from "@playwright/test";

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
    test(`${screen} composes without horizontal page overflow at ${width} CSS px`, async ({ context, page }) => {
      await context.addCookies([
        { name: "NEXT_LOCALE", value: "en", url: "http://127.0.0.1:3100" },
      ]);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/prototype?screen=${screen}`);

      await expect(page.getByRole("navigation", { name: "Company navigation" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }
}

test("prototype has visible keyboard focus and stops processing motion when requested", async ({ context, page }) => {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: "http://127.0.0.1:3100" },
  ]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/prototype?screen=overview");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();

  const animatedBar = page.getByRole("status").filter({ hasText: "AI processing" }).locator("div[aria-hidden=true] > span");
  await expect(animatedBar).toHaveCSS("animation-name", "none");
});

test("mobile VAT Return exposes its scroll region and keeps blocked finalization unavailable", async ({ context, page }) => {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: "http://127.0.0.1:3100" },
  ]);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/prototype?screen=vat-output");

  await expect(page.getByRole("region", { name: "VAT Return lines" })).toHaveAttribute("tabindex", "0");
  await expect(page.getByRole("button", { name: "Finalize and create final XML" })).toBeDisabled();
});

test("the Company chooser is keyboard operable and preserves Company identity on mobile review", async ({ context, page }) => {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: "http://127.0.0.1:3100" },
  ]);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/prototype?screen=review");

  const chooser = page.getByRole("button", { name: "Choose Company, Ateliér Novák s.r.o." });
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

test("mobile capture shows photo controls before an active batch and keeps the human action blue", async ({ context, page }) => {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: "http://127.0.0.1:3100" },
  ]);
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

test("Control Statement has its own destination and output", async ({ context, page }) => {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: "http://127.0.0.1:3100" },
  ]);
  await page.goto("/prototype?screen=vat-output");

  const statement = page.getByRole("link", { name: "Control Statement" });
  await expect(statement).toHaveAttribute("href", "/prototype?screen=vat-statement");
  await statement.click();
  await expect(page).toHaveURL(/screen=vat-statement/);
  await expect(page.getByRole("heading", { name: "Control Statement · September 2026" })).toBeVisible();
  await expect(page.getByText("DRAFT_DPHKH1_2026-09.xml")).toBeVisible();
});

test("Czech Upload and English review preserve the same workflow", async ({ context, page }) => {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "cs", url: "http://127.0.0.1:3100" },
  ]);
  await page.goto("/prototype?screen=upload");
  await expect(page.getByRole("button", { name: "Vyfotit doklad" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Probíhá vytěžení" })).toBeVisible();

  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: "http://127.0.0.1:3100" },
  ]);
  await page.goto("/prototype?screen=review");
  await expect(page.getByRole("button", { name: "Approve document" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next document" })).toBeVisible();
});
