import { expect, test } from "@playwright/test";

const widths = [360, 720, 1024, 1440];

for (const width of widths) {
  test(`prototype composes without horizontal page overflow at ${width} CSS px`, async ({ context, page }) => {
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "en", url: "http://127.0.0.1:3100" },
    ]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/prototype?screen=overview");

    await expect(page.getByRole("navigation", { name: "Company navigation" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
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
