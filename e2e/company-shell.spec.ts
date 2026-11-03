import { provisionAndLogIn } from "./support/accounts";
import fs from "node:fs/promises";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Database } from "../src/lib/database.types";
import { addBrowserCompanyMemberFixture, assignBrowserAiConfigurationFixture } from "../tests/support/e2e";

const password = "Playwright-password-76";

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
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return number.toString().padStart(6, "0");
}

async function provisionAdministrator(page: Page, organization: string, email: string) {
  await provisionAndLogIn(page, { organizationName: organization, email, password });
  await expect(page).toHaveURL(/\/companies\/new$/);
}

async function createCompany(page: Page, name: string, ico: string, enableAi = false) {
  await page.goto("/companies/new");
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
  if (enableAi) {
    await assignBrowserAiConfigurationFixture(companyId);
  }
  await page.goto(`/companies/${companyId}`);
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+$/);
  return companyId;
}

async function expectSingleCompanyShell(page: Page, active: "Overview" | "Upload" | "Documents" | "VAT" | "Settings") {
  const navigation = page.getByRole("navigation", { name: "Company navigation" });
  await expect(navigation).toHaveCount(1);
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link", { name: active, exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
  await expect(page.getByRole("main")).toHaveCount(1);
}

async function serviceClient() {
  const contents = await fs.readFile(".env.local", "utf8");
  const environment = Object.fromEntries(contents.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  return createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function english(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
}

test("Company context, final navigation and account return stay explicit", async ({ baseURL, context, page }) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `shell-admin-${run}@example.test`;
  await provisionAdministrator(page, `Shell Organization ${run}`, email);
  const firstId = await createCompany(page, `Alpha ${run}`, `${Date.now()}`.slice(-8));
  const secondId = await createCompany(page, `Zeta ${run}`, `${Date.now() + 1}`.slice(-8));

  // Leave the Company layout before clearing its preference. The shell writes
  // the current Company in a background Server Action; navigating away first
  // prevents an in-flight response from restoring the cookie after the clear.
  await page.goto("about:blank");
  await context.clearCookies({ name: "ivat_company_context" });
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Choose a Company" })).toBeVisible();
  await expect(page.getByRole("button", { name: `Alpha ${run}` })).toBeVisible();
  await expect(page.getByRole("button", { name: `Zeta ${run}` })).toBeVisible();
  await page.getByRole("button", { name: `Alpha ${run}` }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${firstId}$`));

  const destinations = [
    ["Overview", ""], ["Upload", "/upload"], ["Documents", "/documents"],
    ["VAT", "/vat"], ["Settings", "/settings"],
  ] as const;
  const companyNavigation = page.getByRole("navigation", { name: "Company navigation" });
  for (const [label, suffix] of destinations) {
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/companies/${firstId}${suffix}$`));
    await expect(companyNavigation.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(companyNavigation.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
  }
  await page.goto(`/companies/${firstId}/documents`);
  const companyGridX = (await page.getByRole("heading", { name: "Documents", level: 1 }).boundingBox())?.x;
  expect(companyGridX).toBeDefined();
  await page.goto(`/companies/${firstId}/vat-reports`);
  await expect(page.getByRole("link", { name: "VAT", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto(`/companies/${firstId}/settings`);
  await expect(page.getByRole("link", { name: "Users and access" }).first()).toHaveAttribute(
    "href",
    `/companies/${firstId}/settings/users`,
  );
  await page.goto(`/companies/${firstId}/members`);
  await expect(page).toHaveURL(new RegExp(`/companies/${firstId}/settings/users$`));
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
  const membersHeading = page.getByRole("heading", { name: `Users of Alpha ${run}` });
  await expect(membersHeading).toBeVisible();
  expect((await page.getByRole("heading", { name: "Company settings", level: 1 }).boundingBox())?.x).toBe(companyGridX);
  const inheritedAccess = page.locator(".member-access-row").filter({ hasText: email })
    .getByRole("group", { name: `Organization Membership: Shell Organization ${run}`, exact: true });
  await expect(inheritedAccess.getByText("Inherited from Organization", { exact: true })).toBeVisible();
  await expect(inheritedAccess.getByRole("button", {
    name: `Remove Membership — Organization Membership: Shell Organization ${run}`, exact: true,
  })).toBeVisible();

  const invitedEmail = `shell-invited-${run}@example.test`;
  await page.getByLabel("Email").fill(invitedEmail);
  await page.getByRole("button", { name: "Invite user" }).click();
  const pendingInvitation = page.getByRole("listitem").filter({ hasText: invitedEmail });
  await expect(pendingInvitation.getByText("Pending", { exact: true })).toBeVisible();
  await expect(pendingInvitation.getByText(/^Expires /)).toBeVisible();

  await page.goto(`/companies/${firstId}/setup/filing-frequency`);
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Choose Company" }).click();
  await page.getByRole("menuitem", { name: `Zeta ${run}` }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${secondId}$`));
  await page.getByRole("button", { name: "Open account menu" }).click();
  await expect(page.getByRole("menu").getByText(email)).toBeVisible();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${secondId}$`));

  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "cs", url: new URL(baseURL).origin }]);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Navigace firmy" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Přehled", exact: true })).toHaveAttribute("aria-current", "page");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Company navigation" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/companies/${secondId}$`));
});

test("mobile shell menus return focus and role-dependent administration stays presentational", async ({ baseURL, browser }) => {
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const adminContext = await browser.newContext();
  await english(adminContext, baseURL);
  const adminPage = await adminContext.newPage();
  const adminEmail = `shell-owner-${run}@example.test`;
  await provisionAdministrator(adminPage, `Owner Organization ${run}`, adminEmail);
  const companyId = await createCompany(adminPage, `Role Company ${run}`, `${Date.now()}`.slice(-8));

  await adminPage.setViewportSize({ width: 360, height: 800 });
  await adminPage.reload();
  await adminPage.keyboard.press("Tab");
  await expect(adminPage.getByRole("link", { name: "Skip to content" })).toBeFocused();
  for (const label of ["Choose Company", "Open account menu"]) {
    const trigger = adminPage.getByRole("button", { name: label });
    await trigger.focus();
    await adminPage.keyboard.press("Enter");
    const menuItems = adminPage.getByRole("menu", { name: label }).getByRole("menuitem");
    await expect(menuItems.first()).toBeFocused();
    await adminPage.keyboard.press("End");
    await expect(menuItems.last()).toBeFocused();
    await adminPage.keyboard.press("Home");
    await expect(menuItems.first()).toBeFocused();
    await adminPage.keyboard.press("Escape");
    await expect(adminPage.getByRole("menu", { name: label })).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  await expect(adminPage.getByRole("button", { name: "Open administration menu" })).toHaveCount(0);
  await adminPage.goto(`/companies/${companyId}/settings`);
  await expect(
    adminPage.getByRole("navigation", { name: "Company settings sections" }).locator(`a[href="/companies/${companyId}/settings/users"]`),
  ).toBeVisible();

  for (const width of [360, 720, 1024, 1440]) {
    await adminPage.setViewportSize({ width, height: 900 });
    expect(await adminPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }

  await adminPage.emulateMedia({ colorScheme: "dark" });
  await adminPage.setViewportSize({ width: 1440, height: 900 });
  await adminPage.goto(`/companies/${companyId}/documents`);
  const documentsHeading = adminPage.getByRole("heading", { name: "Documents", level: 1 });
  const documentFilters = adminPage.getByRole("form", { name: "Filters" });
  await expect(documentsHeading).toBeVisible();
  await expect(documentFilters).toBeVisible();
  const desktopGrid = await Promise.all([
    documentsHeading.evaluate((heading) => heading.closest("header")?.getBoundingClientRect().x),
    documentFilters.evaluate((filters) => filters.getBoundingClientRect().x),
  ]);
  expect(desktopGrid[0]).toBe(desktopGrid[1]);
  await expect.poll(() => adminPage.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");

  await adminPage.setViewportSize({ width: 360, height: 800 });
  const mobileGrid = await Promise.all([
    documentsHeading.evaluate((heading) => heading.closest("header")?.getBoundingClientRect().x),
    documentFilters.evaluate((filters) => filters.getBoundingClientRect().x),
  ]);
  expect(mobileGrid[0]).toBe(14);
  expect(mobileGrid[0]).toBe(mobileGrid[1]);
  expect(await adminPage.evaluate(() => document.documentElement.scrollWidth)).toBe(360);

  const userContext = await browser.newContext();
  await english(userContext, baseURL);
  const userPage = await userContext.newPage();
  const userEmail = `shell-user-${run}@example.test`;
  await provisionAdministrator(userPage, `User Organization ${run}`, userEmail);
  const service = await serviceClient();
  const [{ data: company }, { data: users }] = await Promise.all([
    service.from("company").select("organization_id").eq("id", companyId).single(),
    service.auth.admin.listUsers(),
  ]);
  const adminUserId = users.users.find((user) => user.email === adminEmail)?.id;
  if (!company || !adminUserId) throw new Error("Could not prepare User browser fixtures");
  await addBrowserCompanyMemberFixture(companyId, userEmail);
  await userPage.goto(`/companies/${companyId}`);
  await expect(userPage).toHaveURL(new RegExp(`/companies/${companyId}$`));
  await adminPage.goto(`/companies/${companyId}/members`);
  const directAccess = adminPage.locator(".member-access-row").filter({ hasText: userEmail });
  await expect(directAccess.getByText("Direct Company access", { exact: true })).toBeVisible();
  await expect(directAccess.getByRole("button", { name: /Remove Membership/ })).toBeVisible();
  const roleForm = directAccess.locator("form").filter({
    has: adminPage.getByRole("button", { name: /Change Role/ }),
  });
  const role = roleForm.getByLabel("Role");
  await role.selectOption("administrator");
  await roleForm.evaluate((form) => {
    form.addEventListener("formdata", (event) => {
      (event as FormDataEvent).formData.set(
        "membershipId",
        "00000000-0000-4000-8000-000000000000",
      );
    }, { once: true });
  });
  await roleForm.getByRole("button", { name: /Change Role/ }).click();
  await expect(directAccess.getByText("You are not allowed to do this.")).toBeVisible();
  await expect(role).toHaveValue("user");
  await userPage.goto(`/companies/${companyId}/members`);
  await expect(userPage).toHaveURL(new RegExp(`/companies/${companyId}$`));
  for (const destination of ["company", "vat", "users", "data"]) {
    await userPage.goto(`/companies/${companyId}/settings/${destination}`);
    await expect(userPage).toHaveURL(new RegExp(`/companies/${companyId}$`));
  }
  await userPage.goto(`/companies/${companyId}/setup/filing-frequency`);
  await expect(userPage).toHaveURL(new RegExp(`/companies/${companyId}$`));
  await expect(userPage.locator(`a[href="/companies/${companyId}/settings/users"]`)).toHaveCount(0);

  const { error: platformError } = await service.from("platform_user").insert({ role: "super_admin", user_id: adminUserId });
  if (platformError) throw platformError;
  await adminPage.setViewportSize({ width: 1440, height: 900 });
  await adminPage.reload();
  await expect(adminPage).toHaveURL(/\/mfa\/enroll$/);
  await adminPage.getByRole("button", { name: "Start setup" }).click();
  const secret = await adminPage.locator("code").textContent();
  if (!secret) throw new Error("MFA enrollment did not expose a setup key");
  await adminPage.getByLabel("Authenticator code").fill(authenticatorCode(secret));
  await adminPage.getByRole("button", { name: "Verify and enable" }).click();
  await adminPage.getByRole("link", { name: "I saved the codes" }).click();
  await expect(adminPage).toHaveURL(new RegExp(`/companies/${companyId}$`));
  await expect(
    adminPage.getByRole("link", { name: "Switch to SuperAdmin", exact: true }),
  ).toBeVisible();

  await adminContext.close();
  await userContext.close();
});

test("nested Company routes keep one aligned shell at desktop and mobile widths", async ({ baseURL, context, page }) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const companyName = `Nested Company ${run}`;
  await provisionAdministrator(page, `Nested Organization ${run}`, `nested-${run}@example.test`);
  const companyId = await createCompany(page, companyName, `${Date.now()}`.slice(-8), true);

  await page.goto(`/companies/${companyId}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/receipt.jpg");
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page).toHaveURL(/\/upload-batches\/[0-9a-f-]+$/);
  await expect(page.getByRole("link", { name: "Review 1 Document" })).toBeVisible({ timeout: 45_000 });
  const batchHref = new URL(page.url()).pathname;
  const sourceHref = await page.getByRole("link", { name: "receipt.jpg", exact: true }).getAttribute("href");
  const documentHref = await page.locator('a[href*="/documents/"]').first().getAttribute("href");
  expect(sourceHref).toBeTruthy();
  expect(documentHref).toBeTruthy();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/companies/${companyId}`);
  await expectSingleCompanyShell(page, "Overview");
  const companyGridX = (await page.getByRole("heading", { name: "Overview", level: 1 }).boundingBox())?.x;
  expect(companyGridX).toBeDefined();

  const desktopRoutes = [
    [`/companies/${companyId}/upload`, "Upload"],
    [batchHref, "Upload"],
    [sourceHref!, "Upload"],
    [documentHref!, "Documents"],
    [`/companies/${companyId}/vat`, "VAT"],
    [`/companies/${companyId}/vat-reports`, "VAT"],
    [`/companies/${companyId}/settings`, "Settings"],
    [`/companies/${companyId}/settings/company`, "Settings"],
    [`/companies/${companyId}/settings/vat`, "Settings"],
    [`/companies/${companyId}/settings/users`, "Settings"],
    [`/companies/${companyId}/settings/data`, "Settings"],
    [`/companies/${companyId}/members`, "Settings"],
    [`/companies/${companyId}/setup/filing-frequency`, "Settings"],
    [`/companies/${companyId}/setup/ai-processing`, "Settings"],
  ] as const;
  for (const [href, active] of desktopRoutes) {
    await page.goto(href);
    await expectSingleCompanyShell(page, active);
    expect((await page.getByRole("heading", { level: 1 }).first().boundingBox())?.x).toBe(companyGridX);
  }

  await page.setViewportSize({ width: 360, height: 800 });
  for (const [href, active] of [
    [sourceHref!, "Upload"],
    [documentHref!, "Documents"],
    [`/companies/${companyId}/vat-reports`, "VAT"],
    [`/companies/${companyId}/settings`, "Settings"],
    [`/companies/${companyId}/settings/data`, "Settings"],
    [`/companies/${companyId}/setup/filing-frequency`, "Settings"],
  ] as const) {
    await page.goto(href);
    await expectSingleCompanyShell(page, active);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  }
  await page.goto(`/companies/${companyId}/settings`);
  const settingsNavigation = page.getByRole("navigation", { name: "Company settings sections" });
  await expect(settingsNavigation).toBeVisible();
  await settingsNavigation.getByRole("link", { name: "Company details" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/settings/company$`));
  await expect(settingsNavigation.getByRole("link", { name: "Company details" })).toHaveAttribute("aria-current", "page");
});
