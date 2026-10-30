import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const locale of ["cs", "en"] as const) {
  test(`light authentication frame and brand remain usable in ${locale}`, async ({ baseURL, context, page }) => {
    if (!baseURL) throw new Error("Browser base URL missing");
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: new URL(baseURL).origin }]);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.goto("/login");
    const panel = page.locator(".focused-shell-panel");
    await expect(panel.getByRole("link", { name: "iVAT", exact: true })).toBeVisible();
    await expect(page.getByRole("banner").getByRole("button", { name: locale === "cs" ? "English" : "Čeština", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: locale === "cs" ? "Zaregistrujte se" : "Sign up", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Google/ })).toHaveCount(0);
    for (const width of [360, 720, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
      await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator(".auth-document-art")).toHaveAttribute("aria-hidden", "true");
      if (width < 1024) await expect(page.locator(".auth-document-art")).toBeHidden();
      await page.screenshot({ path: `test-results/brand-login-${locale}-${width}.png`, fullPage: true });
    }
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: locale === "cs" ? "Přeskočit na obsah" : "Skip to content" })).toBeFocused();
    await page.getByLabel(locale === "cs" ? "E-mail" : "Email", { exact: true }).focus();
    expect(await page.getByLabel(locale === "cs" ? "E-mail" : "Email", { exact: true }).evaluate(input => getComputedStyle(input).outlineStyle)).not.toBe("none");
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await page.goto("/invitations/accept?token=invalid");
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `test-results/brand-invitation-${locale}-${width}.png`, fullPage: true });
    }
  });
}

test("anonymous browsers receive the vector mark and actual multi-size application icons", async ({ request, page }) => {
  await page.goto("/login");
  const logo = await request.get("/brand/logo.svg");
  expect(logo.ok()).toBe(true);
  expect(logo.headers()["content-type"]).toContain("image/svg+xml");
  const ico = await (await request.get("/favicon.ico")).body();
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico.readUInt16LE(4)).toBe(3);
  expect([0, 1, 2].map(index => [ico[6 + index * 16], ico[7 + index * 16]])).toEqual([[16, 16], [32, 32], [48, 48]]);
  for (const index of [0, 1, 2]) {
    const offset = ico.readUInt32LE(6 + index * 16 + 12);
    expect([ico.readUInt32BE(offset + 16), ico.readUInt32BE(offset + 20)]).toEqual([[16, 16], [32, 32], [48, 48]][index]);
  }
  for (const [name, size] of [["apple-icon.png", 180], ["icon1.png", 512]] as const) {
    const href = await page.locator(`link[href^="/${name}"]`).getAttribute("href");
    if (!href) throw new Error(`Missing ${name} metadata`);
    const bytes = await (await request.get(href)).body();
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([size, size]);
  }
});
