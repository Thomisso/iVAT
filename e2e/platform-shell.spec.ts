import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Database } from "../src/lib/database.types";

const password = "Playwright-password-76";

function authenticatorCode(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replace(/\s/g, "").toUpperCase()) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from(
    bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? [],
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = digest.at(-1)! & 0xf;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return number.toString().padStart(6, "0");
}

async function english(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin },
  ]);
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
  await page.getByLabel("Company name").fill(name);
  await page.getByLabel("IČO").fill(ico);
  await page.getByLabel("VAT ID").fill(`CZ${ico}`);
  await page.getByLabel("Street name").fill("Na Příkopě");
  await page.getByLabel("House number").fill("1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(
    /\/companies\/[0-9a-f-]+\/setup\/filing-frequency$/,
  );
  const companyId = new URL(page.url()).pathname.split("/")[2];
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/companies/${companyId}/setup/ai-processing$`),
  );
  await page.goto(`/companies/${companyId}`);
  return companyId;
}

async function serviceClient() {
  const contents = await fs.readFile(".env.local", "utf8");
  const environment = Object.fromEntries(
    contents
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  return createClient<Database>(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    environment.SUPABASE_SECRET_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

async function promoteAndEnroll(page: Page, email: string) {
  const service = await serviceClient();
  const { data: users } = await service.auth.admin.listUsers();
  const userId = users.users.find((user) => user.email === email)?.id;
  if (!userId) throw new Error("Could not find the SuperAdmin browser fixture");
  const promoted = await service
    .from("platform_user")
    .insert({ role: "super_admin", user_id: userId });
  if (promoted.error) throw promoted.error;

  await page.reload();
  await expect(page).toHaveURL(/\/mfa\/enroll$/);
  await page.getByRole("button", { name: "Start setup" }).click();
  const secret = await page.locator("code").textContent();
  if (!secret) throw new Error("MFA enrollment did not expose a setup key");
  await page.getByLabel("Authenticator code").fill(authenticatorCode(secret));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await page.getByRole("link", { name: "I saved the codes" }).click();
}

test("only a SuperAdmin navigates the shared Platform shell without losing existing operations", async ({
  baseURL,
  context,
  page,
}) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `platform-shell-${run}@example.test`;
  await signUp(page, `Platform Organization ${run}`, email);
  const companyId = await createCompany(
    page,
    `Platform Company ${run}`,
    `${Date.now()}`.slice(-8),
  );

  const administration = page.getByRole("navigation", {
    name: "Administration",
  });
  await expect(administration).toBeVisible();
  await expect(
    administration.getByRole("link", { name: "Platform overview" }),
  ).toHaveCount(0);
  await page.goto("/platform/administration");
  await expect(
    page.getByRole("navigation", { name: "Platform navigation" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Platform administration" }),
  ).toHaveCount(0);

  await promoteAndEnroll(page, email);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/companies/${companyId}`);
  await administration
    .getByRole("group", { name: "Platform administration" })
    .getByRole("link", { name: "Platform overview" })
    .click();
  await expect(page).toHaveURL(/\/platform\/administration$/);
  await expect(
    administration
      .getByRole("group", { name: "Platform administration" })
      .getByRole("link", { name: "Platform AI usage" }),
  ).toBeVisible();
  await expect(
    administration.getByRole("group", { name: "Company administration" }),
  ).toHaveCount(0);

  const navigation = page.getByRole("navigation", {
    name: "Platform navigation",
  });
  await expect(navigation).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Company navigation" }),
  ).toHaveCount(0);
  await expect(
    page.locator('[role="group"][aria-label="Platform context"]:visible'),
  ).toContainText("Platform");
  await expect(
    page.locator('[role="group"][aria-label="Platform context"]:visible'),
  ).toContainText("Administration");
  await expect(
    navigation.getByRole("link", { name: "Platform overview" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Platform administration", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Operational problems" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Organizations and Companies" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Failed processing jobs" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Upload limits" }),
  ).toBeVisible();

  const main = page.getByRole("main");
  const alignedEdges = await Promise.all([
    main
      .locator(":scope > header")
      .evaluate((node) => node.getBoundingClientRect().x),
    page
      .getByRole("heading", { name: "Organizations and Companies" })
      .locator("xpath=ancestor::section")
      .evaluate((node) => node.getBoundingClientRect().x),
  ]);
  expect(alignedEdges[0]).toBe(alignedEdges[1]);

  await navigation.getByRole("link", { name: "Platform AI settings" }).click();
  await expect(page).toHaveURL(/\/platform\/ai-settings$/);
  await expect(
    navigation.getByRole("link", { name: "Platform AI settings" }),
  ).toHaveAttribute("aria-current", "page");
  const configurations = page
    .getByRole("heading", { name: "AI configurations", level: 2 })
    .locator("xpath=ancestor::section");
  await expect(configurations).toBeVisible();
  const [configurationsBox, labelBox, providerBox] = await Promise.all([
    configurations.boundingBox(),
    configurations.getByLabel("Configuration label").first().boundingBox(),
    configurations.getByLabel("Provider").first().boundingBox(),
  ]);
  expect(configurationsBox!.width).toBeGreaterThan(1000);
  expect(providerBox!.x).toBeGreaterThan(labelBox!.x + labelBox!.width);
  expect(Math.abs(providerBox!.y - labelBox!.y)).toBeLessThan(2);
  await navigation.getByRole("link", { name: "Platform AI usage" }).click();
  await expect(page).toHaveURL(/\/platform\/ai-usage$/);
  await expect(
    navigation.getByRole("link", { name: "Platform AI usage" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Platform AI usage", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("form", { name: "Usage filters" })).toBeVisible();

  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  const accountTrigger = page.getByRole("button", {
    name: "Open account menu",
  });
  await accountTrigger.focus();
  await page.keyboard.press("ArrowDown");
  const accountItems = page
    .getByRole("menu", { name: "Open account menu" })
    .getByRole("menuitem");
  await expect(accountItems.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(accountItems.last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(accountTrigger).toBeFocused();
  await expect(
    page.getByRole("link", { name: "Return to Company work" }),
  ).toHaveAttribute("href", `/companies/${companyId}`);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
});

test("an MFA-verified SuperAdmin discovers and administers a Company without any target Membership", async ({
  baseURL, context, page,
}) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const targetOrganization = `Independent Organization ${run}`;
  await signUp(page, targetOrganization, `target-${run}@example.test`);
  const companyId = await createCompany(page, `Independent Company ${run}`, `${Date.now()}`.slice(-8));
  const service = await serviceClient();
  const target = await service.from("company").select("organization_id").eq("id", companyId).single();
  if (target.error) throw target.error;

  await context.clearCookies();
  await english(context, baseURL);
  const operatorEmail = `independent-operator-${run}@example.test`;
  await signUp(page, `Operator Organization ${run}`, operatorEmail);
  await promoteAndEnroll(page, operatorEmail);
  await page.goto("/");
  const companyLink = page.getByRole("button", { name: `Independent Company ${run}`, exact: true });
  await expect(companyLink).toBeVisible();
  await companyLink.click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));

  await page.goto(`/companies/${companyId}/settings/company`);
  await page.getByLabel("Company name").fill(`Platform updated ${run}`);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/settings$`));
  await page.goto(`/companies/${companyId}/settings/company`);
  await expect(page.getByLabel("Company name")).toHaveValue(`Platform updated ${run}`);

  await page.goto(`/organizations/${target.data.organization_id}/members`);
  await expect(page.getByRole("heading", { name: `Users of ${targetOrganization}` })).toBeVisible();
  await page.goto(`/organizations/${target.data.organization_id}/audit-log`);
  await expect(page.getByRole("heading", { name: `Audit log for ${targetOrganization}`, exact: true })).toBeVisible();
  await expect(page.getByText(operatorEmail, { exact: true }).first()).toBeVisible();

  const users = await service.auth.admin.listUsers();
  const operatorId = users.data.users.find((user) => user.email === operatorEmail)?.id;
  if (!operatorId) throw new Error("Operator fixture is missing");
  const memberships = await service.from("membership").select("id")
    .eq("user_id", operatorId).eq("organization_id", target.data.organization_id);
  expect(memberships.error).toBeNull();
  expect(memberships.data).toEqual([]);
});
