import { provisionAndLogIn } from "./support/accounts";
import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { addBrowserCompanyMemberFixture, promoteBrowserSuperAdminFixture } from "../tests/support/e2e";

const password = "Playwright-password-148";

async function provisionAdministrator(page: Page, organization: string, email: string) {
  await provisionAndLogIn(page, { organizationName: organization, email, password });
  await expect(page).toHaveURL(/\/companies\/new$/);
}

function authenticatorCode(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replace(/\s/g, "").toUpperCase()) bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest.at(-1)! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

test("Settings navigation follows actual scoped Roles and a membership-free SuperAdmin", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const english = () => context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  await english();
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const organization = `Settings Organization ${run}`;
  await provisionAdministrator(page, organization, `settings-owner-${run}@example.test`);
  await page.getByLabel("Company name").fill(`Settings Company ${run}`);
  const ico = Date.now().toString().slice(-8);
  await page.getByLabel("IČO").fill(ico);
  await page.getByLabel("VAT ID").fill(`CZ${ico}`);
  await page.getByLabel("Street name").fill("Na Příkopě");
  await page.getByLabel("House number").fill("1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company", exact: true }).click();
  await expect(page).toHaveURL(/\/setup\/filing-frequency$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await expect(page).toHaveURL(/\/setup\/ai-processing$/);
  await page.goto(`/companies/${companyId}`);
  await expect(page.getByRole("navigation", { name: "Administration", exact: true })).toHaveCount(0);
  const companyNavigation = page.getByRole("navigation", { name: "Company navigation", exact: true });
  const settings = companyNavigation.getByRole("link", { name: "Settings", exact: true });
  await expect(settings).toHaveCount(1);
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/companies/${companyId}/settings`);
  await expect(page.getByRole("heading", { name: "Company settings", exact: true })).toBeVisible();
  const organizationArea = page.getByRole("region", { name: `Organization settings: ${organization}`, exact: true });
  await expect(organizationArea.getByRole("link", { name: /^Organization users/ })).toBeVisible();
  const organizationHref = await organizationArea.getByRole("link", { name: /^Organization users/ }).getAttribute("href");
  if (!organizationHref) throw new Error("Organization settings link is missing");

  await context.clearCookies(); await english();
  const userEmail = `settings-user-${run}@example.test`;
  await provisionAdministrator(page, `User own Organization ${run}`, userEmail);
  await addBrowserCompanyMemberFixture(companyId, userEmail);
  await page.goto(`/companies/${companyId}`);
  await expect(companyNavigation.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Administration", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open account menu" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("menuitem", { name: "Security", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/security\?returnTo=/);
  await expect(page.getByRole("link", { name: "Return to work", exact: true })).toHaveAttribute("href", `/companies/${companyId}`);
  await expect(page.getByRole("link", { name: "Enable authenticator", exact: true })).toBeVisible();
  await page.goto(`/companies/${companyId}/settings`);
  await expect(page).toHaveURL(`/companies/${companyId}`);

  await context.clearCookies(); await english();
  const companyAdminEmail = `settings-company-admin-${run}@example.test`;
  await provisionAdministrator(page, `Company Administrator own Organization ${run}`, companyAdminEmail);
  await addBrowserCompanyMemberFixture(companyId, companyAdminEmail, "administrator");
  await page.goto(`/companies/${companyId}/settings`);
  await expect(companyNavigation.getByRole("link", { name: "Settings", exact: true })).toHaveCount(1);
  await expect(page.getByRole("region", { name: /Organization settings:/ })).toHaveCount(0);
  await page.goto(organizationHref);
  await expect(page.getByRole("heading", { name: `Users of ${organization}` })).toHaveCount(0);

  await context.clearCookies(); await english();
  const operator = `settings-superadmin-${run}@example.test`;
  await provisionAdministrator(page, `Operator own Organization ${run}`, operator);
  await promoteBrowserSuperAdminFixture(operator);
  await page.goto(`/companies/${companyId}`);
  await expect(page).toHaveURL(/\/mfa\/enroll$/);
  await page.getByRole("button", { name: "Start setup", exact: true }).click();
  const secret = await page.locator("code").textContent();
  if (!secret) throw new Error("Authenticator secret is missing");
  await page.getByLabel("Authenticator code").fill(authenticatorCode(secret));
  await page.getByRole("button", { name: "Verify and enable", exact: true }).click();
  await page.getByRole("link", { name: "I saved the codes", exact: true }).click();
  await page.goto(`/companies/${companyId}/settings`);
  await expect(organizationArea.getByRole("link", { name: /^Organization users/ })).toBeVisible();
  await organizationArea.getByRole("link", { name: /^Organization users/ }).click();
  await expect(page.getByRole("heading", { name: `Users of ${organization}`, exact: true })).toBeVisible();
  await page.goto(`/companies/${companyId}`);
  const toSuperAdmin = page.getByRole("link", { name: "Switch to SuperAdmin", exact: true });
  await expect(toSuperAdmin).toBeVisible();
  await toSuperAdmin.click();
  await expect(page).toHaveURL(/\/platform\/administration$/);
  await expect(page.getByRole("navigation", { name: "Administration", exact: true })).toHaveCount(0);
  const platformNavigation = page.getByRole("navigation", { name: "Platform navigation", exact: true });
  await expect(platformNavigation.getByRole("link", { name: "Settings", exact: true })).toHaveCount(1);
  await expect(platformNavigation.getByRole("link")).toHaveCount(1);
  await platformNavigation.getByRole("link", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/platform\/settings$/);
  await expect(page.getByRole("heading", { name: "SuperAdmin settings", exact: true })).toBeVisible();
  const sections = page.getByRole("navigation", { name: "Platform settings sections", exact: true });
  await sections.getByRole("link", { name: "Platform AI settings", exact: true }).click();
  await expect(page).toHaveURL(/\/platform\/ai-settings$/);
  await sections.getByRole("link", { name: "Platform AI usage", exact: true }).click();
  await expect(page).toHaveURL(/\/platform\/ai-usage$/);
  await page.getByRole("link", { name: "Return to Company work", exact: true }).click();
  await expect(page).toHaveURL(`/companies/${companyId}`);
  for (const width of [360, 720, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(toSuperAdmin).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await context.addCookies([{ name: "NEXT_LOCALE", value: "cs", url: baseURL }]);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Navigace firmy", exact: true }).getByRole("link", { name: "Nastavení", exact: true })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Přepnout do sekce SuperAdmin", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Navigace firmy", exact: true }).getByRole("link", { name: "Nastavení", exact: true }).click();
  const czechOrganizationArea = page.getByRole("region", { name: `Nastavení organizace: ${organization}`, exact: true });
  await expect(czechOrganizationArea.getByRole("link", { name: /^Uživatelé organizace/ })).toBeVisible();
  await expect(czechOrganizationArea.getByRole("link", { name: /^Auditní záznamy organizace/ })).toBeVisible();
  const czechSwitch = page.getByRole("link", { name: "Přepnout do sekce SuperAdmin", exact: true });
  await czechSwitch.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/platform\/administration$/);
  const czechSections = page.getByRole("navigation", { name: "Oblasti nastavení platformy", exact: true });
  await expect(czechSections.getByRole("link", { name: "Nastavení AI platformy", exact: true })).toBeVisible();
  await expect(czechSections.getByRole("link", { name: "Využití AI platformy", exact: true })).toBeVisible();
  for (const width of [360, 720, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(czechSections).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.getByRole("link", { name: "Vrátit se k práci ve firmě", exact: true }).click();
  await expect(page).toHaveURL(`/companies/${companyId}`);
});
