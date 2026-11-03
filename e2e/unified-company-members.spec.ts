import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import type { Database } from "../src/lib/database.types";
import { asUserClient } from "../src/application/client";
import { createCompany } from "../src/application/companies";
import { listMyOrganizations } from "../src/application/organizations";
import { acceptInvitation, generateInvitationLink } from "../src/application/memberships";
import { provisionBrowserAccountFixture } from "../tests/support/e2e";

test("Company context shows one User, real scoped Memberships, Invitations and truthful remaining access in CS/EN", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("Browser URL missing");
  const environment = Object.fromEntries((await fs.readFile(".env.local", "utf8")).split("\n").filter(Boolean).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const run = randomUUID();
  const password = "Scoped-members-browser-192";
  async function account(prefix: string) {
    const email = `${prefix}-${run}@example.test`;
    await provisionBrowserAccountFixture({ email, password, organizationName: `Organization ${prefix} ${run}` });
    const client = asUserClient(createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }));
    const login = await client.auth.signInWithPassword({ email, password });
    if (login.error) throw login.error;
    return { email, client };
  }
  const owner = await account("owner");
  const [organization] = await listMyOrganizations(owner.client);
  const created = await createCompany(owner.client, {
    organizationId: organization.id, name: `Selected Company ${run}`, ico: "27082440", vatId: "CZ27082440",
    personType: "legal", city: "Praha", postalCode: "12000", streetName: "Vinohradská", houseNumber: "12", filingFrequency: "monthly", reportingYear: 2026,
  });
  if (!created.ok) throw new Error(created.error);
  const company = { ...created.value, name: `Selected Company ${run}` };
  const member = await account("member");
  const companyAdmin = await account("company-admin");
  async function invite(email: string, companyId: string | null, role: "user" | "administrator") {
    const result = await generateInvitationLink(owner.client, { organizationId: organization.id, companyId, email, role, acceptUrl: `${baseURL}/invitations/accept` });
    if (!result.ok) throw new Error(result.error);
    return result.value.token;
  }
  for (const [actor, companyId, role] of [
    [member, company.id, "user"], [member, null, "administrator"], [companyAdmin, company.id, "administrator"],
  ] as const) {
    const accepted = await acceptInvitation(actor.client, await invite(actor.email, companyId, role));
    if (!accepted.ok) throw new Error(accepted.error);
  }
  const pendingEmail = `pending-${run}@example.test`;
  await invite(pendingEmail, company.id, "user");
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile("test-results/unified-members-runtime-fixture.json", JSON.stringify({ email: owner.email, password, organizationId: organization.id, companyId: company.id }), { mode: 0o600 });
  async function login(browser: Page, email: string) {
    await context.clearCookies();
    await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL! }]);
    await browser.goto("/login");
    await browser.getByLabel("Email", { exact: true }).fill(email);
    await browser.getByLabel("Password", { exact: true }).fill(password);
    await browser.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(browser).not.toHaveURL(/\/login$/);
  }
  await login(page, owner.email);
  for (const locale of ["en", "cs"] as const) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL }]);
    await page.goto(`/companies/${company.id}/members`);
    await expect(page).toHaveURL(`/companies/${company.id}/settings/users`);
    const user = page.locator(".member-access-row").filter({ hasText: member.email });
    await expect(user).toHaveCount(1);
    await expect(user.getByText(member.email, { exact: true })).toHaveCount(1);
    const direct = user.getByRole("group", { name: `${locale === "en" ? "Company Membership" : "Členství ve společnosti"}: ${company.name}`, exact: true });
    const inherited = user.getByRole("group", { name: `${locale === "en" ? "Organization Membership" : "Členství v organizaci"}: ${organization.name}`, exact: true });
    await expect(direct).toContainText(locale === "en" ? "Regular user" : "Běžný uživatel");
    await expect(inherited).toContainText(locale === "en" ? "Administrator" : "Administrátor");
    await expect(direct.getByRole("button")).toHaveCount(2);
    await expect(inherited.getByRole("button")).toHaveCount(1);
    const pending = page.locator(".member-invitation-row").filter({ hasText: pendingEmail });
    await expect(pending).toHaveCount(1);
    await expect(pending).toContainText(locale === "en" ? "Pending" : "Čeká na přijetí");
    await expect(pending.getByLabel(locale === "en" ? "Invitation link" : "Odkaz pozvánky")).toHaveValue(/#token=/);
    await page.screenshot({ path: `test-results/unified-members-${locale}.png`, fullPage: true });
  }
  await login(page, companyAdmin.email);
  await page.goto(`/companies/${company.id}/settings/users`);
  const user = page.locator(".member-access-row").filter({ hasText: member.email });
  const direct = user.getByRole("group", { name: `Company Membership: ${company.name}`, exact: true });
  const inherited = user.getByRole("group", { name: `Organization Membership: ${organization.name}`, exact: true });
  await expect(inherited).toContainText("Only an Organization Administrator or SuperAdmin can manage this inherited Membership.");
  await expect(inherited.getByRole("button")).toHaveCount(0);
  await direct.getByRole("combobox").selectOption("administrator");
  await direct.getByRole("button", { name: /Change Role/ }).click();
  await expect(direct.getByText("Administrator", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(direct.getByText("Administrator", { exact: true }).first()).toBeVisible();
  await direct.getByRole("button", { name: /Remove Membership/ }).click();
  await expect(direct).toHaveCount(0);
  await expect(user).toHaveCount(1);
  await expect(user.getByText(/Effective Access remains/)).toContainText("Organization Membership");
  await page.reload();
  await expect(user.getByRole("group")).toHaveCount(1);
  const accepted = await acceptInvitation(member.client, await invite(member.email, company.id, "user"));
  if (!accepted.ok) throw new Error(accepted.error);
  await login(page, owner.email);
  await page.goto(`/companies/${company.id}/settings/users`);
  await inherited.getByRole("button", { name: /Remove Membership/ }).click();
  await expect(inherited).toHaveCount(0);
  await expect(user.getByText(/Effective Access remains/)).toContainText("Company Membership");
  await page.reload();
  await expect(direct).toContainText("Regular user");
  await expect(user.getByRole("group")).toHaveCount(1);
});
