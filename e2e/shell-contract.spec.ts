import { createHmac } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectCheckboxTextBeside } from "../tests/support/browser-layout";
import { assignBrowserAiConfigurationFixture, promoteBrowserSuperAdminFixture } from "../tests/support/e2e";

const password = "Playwright-password-107";
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 360, height: 800 },
] as const;

function authenticatorCode(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replace(/\s/g, "").toUpperCase()) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = digest.at(-1)! & 0xf;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

async function attachScreenshot(page: Page, testInfo: TestInfo, context: string, viewport: typeof viewports[number]) {
  await testInfo.attach(`${context}-${viewport.name}`, {
    body: await page.screenshot({ animations: "disabled", fullPage: true }),
    contentType: "image/png",
  });
}

async function expectHeadingOrder(page: Page) {
  const levels = await page.getByRole("main").locator("h1, h2, h3, h4, h5, h6").evaluateAll((headings) =>
    headings.map((heading) => Number(heading.tagName.slice(1))),
  );
  expect(levels[0]).toBe(1);
  expect(levels.filter((level) => level === 1)).toHaveLength(1);
  for (let index = 1; index < levels.length; index += 1) {
    expect(levels[index]).toBeLessThanOrEqual(levels[index - 1] + 1);
  }
}

async function expectAccessibleSurface(page: Page) {
  await expect(page.getByRole("main")).toHaveCount(1);
  await expectHeadingOrder(page);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"),
  ).toEqual([]);
}

async function expectFocusedSkipLink(page: Page) {
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toHaveCSS("outline-style", "solid");
}

async function createCompany(page: Page, name: string, ico: string) {
  await page.getByLabel("Company name").fill(name);
  await page.getByLabel("IČO").fill(ico);
  await page.getByLabel("VAT ID").fill(`CZ${ico}`);
  await page.getByLabel("Street name").fill("Na Příkopě");
  await page.getByLabel("House number").fill("1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/setup\/filing-frequency$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/setup/ai-processing$`));
  await page.goto(`/companies/${companyId}`);
  return companyId;
}

test("real Auth, Company, Organization and Platform surfaces share one accessible light shell", async ({
  baseURL,
  context,
  page,
}, testInfo) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await expect(page.getByRole("banner").getByRole("link", { name: "iVAT" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Log in", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expectAccessibleSurface(page);
    await attachScreenshot(page, testInfo, "auth", viewport);
  }
  await expectFocusedSkipLink(page);

  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `shell-contract-${run}@example.test`;
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Contract Organization ${run}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/companies\/new$/);
  await expect(page.getByRole("banner").getByRole("link", { name: "iVAT" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Add a company", level: 1 })).toBeVisible();
  await expectAccessibleSurface(page);

  const companyId = await createCompany(page, `Contract Company with a long official accounting and advisory business name ${run}`, `${Date.now()}`.slice(-8));
  await page.goto(`/companies/${companyId}/settings`);
  const organizationHref = await page.locator('a[href^="/organizations/"][href$="/members"]').first().getAttribute("href");
  if (!organizationHref) throw new Error("Organization context link was not rendered");

  const configuration = await assignBrowserAiConfigurationFixture(companyId);
  await promoteBrowserSuperAdminFixture(email);
  await page.reload();
  await expect(page).toHaveURL(/\/mfa\/enroll$/);
  await page.getByRole("button", { name: "Start setup" }).click();
  const secret = await page.locator("code").textContent();
  if (!secret) throw new Error("MFA enrollment did not expose a setup key");
  await page.getByLabel("Authenticator code").fill(authenticatorCode(secret));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await page.getByRole("link", { name: "I saved the codes" }).click();

  const surfaces = [
    {
      context: "company",
      href: `/companies/${companyId}`,
      navigation: "Company navigation",
      heading: "Overview",
      content: "main > section",
      menu: "Choose Company",
    },
    {
      context: "organization",
      href: organizationHref,
      navigation: "Organization navigation",
      heading: `Users of Contract Organization ${run}`,
      content: ".app-page-content",
      menu: "Choose Organization",
    },
    {
      context: "platform",
      href: "/platform/administration",
      navigation: "Platform navigation",
      heading: "Platform administration",
      content: "main > section",
      menu: "Open account menu",
    },
  ] as const;
  const alignedContextEdges = new Map<string, number>();

  for (const surface of surfaces) {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(surface.href);
      const navigation = page.getByRole("navigation", { name: surface.navigation });
      await expect(navigation).toBeVisible();
      await expect(page.getByRole("heading", { name: surface.heading, level: 1 })).toBeVisible();
      await expect(page.getByRole("link", { name: "iVAT" }).first()).toBeVisible();
      await expectAccessibleSurface(page);

      const alignedEdges = await Promise.all([
        page.getByRole("heading", { name: surface.heading, level: 1 }).evaluate((node) => node.getBoundingClientRect().x),
        page.locator(surface.content).first().evaluate((node) => node.getBoundingClientRect().x),
      ]);
      expect(Math.round(alignedEdges[0])).toBe(Math.round(alignedEdges[1]));
      const sharedEdge = alignedContextEdges.get(viewport.name);
      if (sharedEdge === undefined) alignedContextEdges.set(viewport.name, Math.round(alignedEdges[0]));
      else expect(Math.round(alignedEdges[0])).toBe(sharedEdge);
      await attachScreenshot(page, testInfo, surface.context, viewport);
    }

    await page.reload();
    await expectFocusedSkipLink(page);
    const trigger = page.getByRole("button", { name: surface.menu });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menu", { name: surface.menu }).getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }

  await page.goto("/platform/ai-settings");
  const configurationCard = page.getByRole("article").filter({ has: page.getByRole("heading", { name: configuration.label, exact: true }) });
  const assignment = page.locator(`#company-${companyId}`);
  const unlimited = assignment.getByRole("checkbox", { name: "Unlimited processing", exact: true });
  for (const width of [360, 720, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(unlimited).toBeVisible();
    await expectCheckboxTextBeside(unlimited);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const control of await assignment.locator('select, input:not([type="hidden"]), button').all()) {
      const bounds = await control.boundingBox();
      if (!bounds) throw new Error("Company administration control is not rendered");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    if (width === 1440) expect((await configurationCard.boundingBox())!.width).toBeGreaterThan(800);
    await testInfo.attach(`platform-ai-${width}`, { body: await configurationCard.screenshot({ path: testInfo.outputPath(`platform-ai-${width}.png`) }), contentType: "image/png" });
  }
  await unlimited.check();
  const allowanceSaved = page.waitForResponse((response) => response.request().method() === "POST" && Boolean(response.request().postData()?.includes("unlimited")));
  await assignment.getByRole("button", { name: "Save allowance", exact: true }).click();
  await allowanceSaved;
  await page.reload();
  await expect(unlimited).toBeChecked();
  await expectAccessibleSurface(page);
});
