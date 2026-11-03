import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { asUserClient } from "../src/application/client";
import { createCompany } from "../src/application/companies";
import { listMyOrganizations } from "../src/application/organizations";
import { totp } from "../tests/support/totp";
import { provisionBrowserAccountFixture } from "../tests/support/e2e";
import type { Database } from "../src/lib/database.types";

async function openSecurity(page: Page) {
  await page.getByRole("button", { name: "Open account menu" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu", { name: "Open account menu" }).getByRole("menuitem").first()).toBeFocused();
  const link = page.getByRole("menuitem", { name: "Security", exact: true });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Security", exact: true })).toBeVisible();
}

test("Security explicitly returns to its precise Company and Organization workflow on desktop and mobile", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("Missing base URL");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const environment = Object.fromEntries((await fs.readFile(".env.local", "utf8")).split("\n").filter(Boolean).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const email = `security-${crypto.randomUUID()}@example.test`;
  const password = "Security-browser-194-password";
  await provisionBrowserAccountFixture({ email, password, organizationName: "Security return Organization" });
  const client = asUserClient(createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }));
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  const [organization] = await listMyOrganizations(client);
  const company = await createCompany(client, { organizationId: organization.id, name: "Security return Company", ico: "27082440", vatId: "CZ27082440", personType: "legal", streetName: "Vinohradská", houseNumber: "12", city: "Praha", postalCode: "12000", filingFrequency: "monthly", reportingYear: 2026 });
  if (!company.ok) throw new Error(company.error);
  const companyId = company.value.id;
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const origin of [
      `/companies/${companyId}/vat-reports?period=2026-10#vat-step-review`,
      `/companies/${companyId}/settings/users?scope=organization`,
      `/organizations/${organization.id}/users?scope=${companyId}`,
      `/organizations/${organization.id}/audit-log?companyId=${companyId}&action=company.created&page=1`,
    ]) {
      await page.goto(origin);
      await openSecurity(page);
      const back = page.getByRole("link", { name: "Return to work", exact: true });
      await expect(back).toHaveAttribute("href", origin);
      await expect(page.getByRole("navigation", { name: /Company navigation|Organization navigation/ })).toHaveCount(0);
      await page.reload();
      await back.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${baseURL}${origin}`);
    }
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const requested of [undefined, "https://evil.test/private", "//evil.test/private", `/companies/${companyId}/documents/00000000-0000-4000-8000-000000000001`, "/platform/administration"]) {
      await page.goto(`/settings/security${requested ? `?${new URLSearchParams({ returnTo: requested })}` : ""}`);
      const back = page.getByRole("link", { name: "Return to work", exact: true });
      await expect(back).toHaveAttribute("href", `/companies/${companyId}`);
      await back.click();
      await expect(page).toHaveURL(`${baseURL}/companies/${companyId}`);
      await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    }
  }
  await page.goto(`/companies/${companyId}/settings`);
  await page.getByRole("link", { name: /^Organization security/ }).click();
  await expect(page.getByRole("link", { name: "Return to work", exact: true })).toHaveAttribute("href", `/companies/${companyId}/settings`);
  const origin = `/companies/${companyId}/documents?view=review&status=review_required&page=1`;
  await page.goto(origin);
  await openSecurity(page);
  await page.getByRole("link", { name: "Enable authenticator", exact: true }).click();
  await expect(page.getByRole("link", { name: "Security", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start setup", exact: true }).click();
  const secret = await page.locator("code").textContent();
  if (!secret) throw new Error("Missing TOTP setup key");
  await page.getByLabel("Authenticator code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify and enable", exact: true }).click();
  await page.getByRole("link", { name: "I saved the codes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Security", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Return to work", exact: true })).toHaveAttribute("href", origin);
  await page.getByRole("button", { name: "Čeština", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Zabezpečení", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Zpět k práci", exact: true })).toHaveAttribute("href", origin);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: "test-results/194-security-mobile-cs.png", fullPage: true });
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Security", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "test-results/194-security-desktop-en.png", fullPage: true });
  const securityUrl = page.url();
  const administration = await context.newPage();
  await administration.goto(`/organizations/${organization.id}/users`);
  await administration.locator(".member-access-row").filter({ hasText: email }).getByRole("button", { name: /Remove Membership/ }).click();
  await expect(administration.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
  await administration.close();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(securityUrl);
    const fallback = page.getByRole("link", { name: "Return to work", exact: true });
    await expect(fallback).toHaveAttribute("href", "/");
    await fallback.click();
    await expect(page).toHaveURL(`${baseURL}/`);
    await expect(page.getByRole("heading", { name: "Choose a Company", exact: true })).toBeVisible();
  }
});
