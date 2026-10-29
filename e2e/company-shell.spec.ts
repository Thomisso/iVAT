import fs from "node:fs/promises";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { asUserClient } from "../src/application/client";
import { inviteMember } from "../src/application/memberships";
import type { Database } from "../src/lib/database.types";

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

async function signUp(page: Page, organization: string, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(organization);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/companies\/new$/);
}

async function createCompany(page: Page, name: string, ico: string) {
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
  await page.getByLabel("Effective from").fill("2026-01-01");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/setup/ai-processing$`));
  await page.getByRole("button", { name: "Continue without AI" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+$/);
  return companyId;
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

async function signedInApplicationClient(email: string) {
  const contents = await fs.readFile(".env.local", "utf8");
  const environment = Object.fromEntries(contents.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const client = createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  return asUserClient(client);
}

async function english(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
}

test("Company context, final navigation and account return stay explicit", async ({ baseURL, context, page }) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `shell-admin-${run}@example.test`;
  await signUp(page, `Shell Organization ${run}`, email);
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
  await page.goto(`/companies/${firstId}/vat-reports`);
  await expect(page.getByRole("link", { name: "VAT", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto(`/companies/${firstId}/settings`);
  await expect(page.getByRole("link", { name: "Manage users" })).toHaveAttribute(
    "href",
    `/companies/${firstId}/members`,
  );
  await page.goto(`/companies/${firstId}/members`);
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: `Users of Alpha ${run}` })).toBeVisible();
  const inheritedAccess = page.getByRole("listitem").filter({ hasText: email });
  await expect(inheritedAccess.getByText("Inherited from Organization", { exact: true })).toBeVisible();
  await expect(inheritedAccess.getByRole("button", { name: "Remove access" })).toHaveCount(0);

  const invitedEmail = `shell-invited-${run}@example.test`;
  await page.getByLabel("Email").fill(invitedEmail);
  await page.getByRole("button", { name: "Invite user" }).click();
  const pendingInvitation = page.getByRole("listitem").filter({ hasText: invitedEmail });
  await expect(pendingInvitation.getByText("Pending", { exact: true })).toBeVisible();
  await expect(pendingInvitation.getByText(/^Expires /)).toBeVisible();

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
  await signUp(adminPage, `Owner Organization ${run}`, adminEmail);
  const companyId = await createCompany(adminPage, `Role Company ${run}`, `${Date.now()}`.slice(-8));

  await adminPage.setViewportSize({ width: 360, height: 800 });
  await adminPage.reload();
  await adminPage.keyboard.press("Tab");
  await expect(adminPage.getByRole("link", { name: "Skip to content" })).toBeFocused();
  for (const label of ["Choose Company", "Open administration menu", "Open account menu"]) {
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
  await adminPage.getByRole("button", { name: "Open administration menu" }).click();
  await expect(adminPage.locator(`a[href="/companies/${companyId}/members"]`)).toBeVisible();

  for (const width of [360, 720, 1024, 1440]) {
    await adminPage.setViewportSize({ width, height: 900 });
    expect(await adminPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }

  const userContext = await browser.newContext();
  await english(userContext, baseURL);
  const userPage = await userContext.newPage();
  const userEmail = `shell-user-${run}@example.test`;
  await signUp(userPage, `User Organization ${run}`, userEmail);
  const service = await serviceClient();
  const [{ data: company }, { data: users }] = await Promise.all([
    service.from("company").select("organization_id").eq("id", companyId).single(),
    service.auth.admin.listUsers(),
  ]);
  const adminUserId = users.users.find((user) => user.email === adminEmail)?.id;
  if (!company || !adminUserId) throw new Error("Could not prepare User browser fixtures");
  let invitationToken = "";
  const invited = await inviteMember(await signedInApplicationClient(adminEmail), {
    async sendInvitation(message) {
      invitationToken = new URL(message.acceptUrl).searchParams.get("token") ?? "";
    },
  }, {
    acceptUrl: `${baseURL}/invitations/accept`,
    companyId,
    email: userEmail,
    organizationId: company.organization_id,
    role: "user",
  });
  if (!invited.ok || !invitationToken) throw new Error("Could not prepare invitation browser fixture");
  await userPage.goto(`/invitations/accept?token=${invitationToken}`);
  await userPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(userPage).toHaveURL(new RegExp(`/companies/${companyId}$`));
  await adminPage.goto(`/companies/${companyId}/members`);
  const directAccess = adminPage.getByRole("listitem").filter({ hasText: userEmail });
  await expect(directAccess.getByText("Direct Company access", { exact: true })).toBeVisible();
  await expect(directAccess.getByRole("button", { name: "Remove access" })).toBeVisible();
  await userPage.goto(`/companies/${companyId}/members`);
  await expect(userPage).toHaveURL(new RegExp(`/companies/${companyId}$`));
  await userPage.getByRole("button", { name: "Open administration menu" }).click();
  await expect(userPage.locator(`a[href="/companies/${companyId}/members"]`)).toHaveCount(0);

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
  await adminPage.getByRole("button", { name: "Open administration menu" }).click();
  await expect(adminPage.getByRole("menuitem", { name: "Platform overview" })).toBeVisible();

  await adminContext.close();
  await userContext.close();
});
