import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import type { Database } from "../src/lib/database.types";
import { asUserClient } from "../src/application/client";
import { createCompany } from "../src/application/companies";
import { listMyOrganizations } from "../src/application/organizations";
import { acceptInvitation, generateInvitationLink } from "../src/application/memberships";
import { addBrowserCompanyMemberFixture, promoteBrowserSuperAdminFixture, provisionBrowserAccountFixture } from "../tests/support/e2e";
import { totp } from "../tests/support/totp";

test("native bootstrap SuperAdmin manages real tenant users without appearing in their CS/EN rows or counts", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("Browser URL missing");
  const environment = Object.fromEntries((await fs.readFile(".env.local", "utf8")).split("\n").filter(Boolean).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const run = randomUUID();
  const password = "Superadmin-members-browser-170";
  async function ordinaryAccount(prefix: string) {
    const email = `${prefix}-${run}@example.test`;
    await provisionBrowserAccountFixture({ email, password, organizationName: `Organization ${prefix} ${run}` });
    const client = asUserClient(createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }));
    const login = await client.auth.signInWithPassword({ email, password });
    if (login.error) throw login.error;
    return { email, client };
  }
  const owner = await ordinaryAccount("owner");
  const [organization] = await listMyOrganizations(owner.client);
  const created = await createCompany(owner.client, {
    organizationId: organization.id, name: `Company ${run}`, ico: "27082440", vatId: "CZ27082440",
    personType: "legal", city: "Praha", postalCode: "12000", streetName: "Vinohradská", houseNumber: "12", filingFrequency: "monthly", reportingYear: 2026,
  });
  if (!created.ok) throw new Error(created.error);
  const companyId = created.value.id;
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile("test-results/superadmin-runtime-fixture.json", JSON.stringify({ email: owner.email, password, organizationId: organization.id, companyId }), { mode: 0o600 });
  const historical = await ordinaryAccount("historical-operator");
  const invitation = await generateInvitationLink(owner.client, {
    organizationId: organization.id, companyId: null, email: historical.email, role: "administrator", acceptUrl: `${baseURL}/invitations/accept`,
  });
  if (!invitation.ok) throw new Error(invitation.error);
  const accepted = await acceptInvitation(historical.client, invitation.value.token);
  if (!accepted.ok) throw new Error(accepted.error);
  await addBrowserCompanyMemberFixture(companyId, historical.email, "administrator");
  await promoteBrowserSuperAdminFixture(historical.email);
  const member = await ordinaryAccount("ordinary-member");
  await addBrowserCompanyMemberFixture(companyId, member.email);
  const operatorEmail = `native-operator-${run}@example.test`;
  execFileSync("node_modules/.bin/tsx", ["scripts/bootstrap-superadmin.ts", "--email", operatorEmail, "--password-stdin"], {
    env: { ...process.env, ...environment }, input: password, stdio: ["pipe", "pipe", "pipe"],
  });

  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(operatorEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(/\/mfa\/enroll$/);
  await page.goto(`/organizations/${organization.id}/members`);
  await expect(page).toHaveURL(/\/mfa\/enroll/);
  await page.getByRole("button", { name: "Start setup", exact: true }).click();
  const secret = await page.locator("code").textContent();
  if (!secret) throw new Error("Native TOTP setup secret missing");
  await page.getByLabel("Authenticator code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify and enable", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  await page.getByRole("link", { name: "I saved the codes" }).click();

  for (const locale of ["en", "cs"] as const) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL }]);
    await page.goto(`/organizations/${organization.id}/members`);
    const organizationRows = page.locator(".member-access-row");
    await expect(organizationRows).toHaveCount(2);
    await expect(organizationRows.filter({ hasText: historical.email })).toHaveCount(0);
    await expect(page.getByLabel(locale === "en" ? "Management scope" : "Rozsah správy", { exact: true })).toHaveValue("organization");
    await expect(organizationRows.filter({ hasText: owner.email })).toHaveCount(1);
    await expect(page.getByText(locale === "en" ? "2 active users" : "2 aktivní uživatelé", { exact: true })).toBeVisible();
    await page.goto(`/platform/companies/${companyId}/members`);
    await expect(page.getByLabel(locale === "en" ? "Management scope" : "Rozsah správy", { exact: true })).toHaveValue(companyId);
    await expect(page.locator(".member-access-row")).toHaveCount(2);
    await page.goto(`/companies/${companyId}/settings/users`);
    await expect(page.locator(".member-access-row")).toHaveCount(2);
    await expect(page.locator(".member-access-row").filter({ hasText: historical.email })).toHaveCount(0);
    await expect(page.getByText(locale === "en" ? "2 active users" : "2 aktivní uživatelé", { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/superadmin-members-${locale}.png`, fullPage: true });
  }
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  await page.goto(`/organizations/${organization.id}/members`);
  const invitedEmail = `invited-by-native-operator-${run}@example.test`;
  await page.getByLabel("Email", { exact: true }).fill(invitedEmail);
  await page.getByRole("button", { name: "Generate link", exact: true }).click();
  const pending = page.locator(".member-invitation-row").filter({ hasText: invitedEmail });
  await expect(pending.getByLabel("Invitation link")).toHaveValue(/#token=/);
  await page.reload();
  await expect(pending).toContainText(invitedEmail);
});
