import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { provisionBrowserAccountFixture } from "../tests/support/e2e";
import { capturedNativeEmail, capturedRecoveryEmail } from "../tests/support/recovery-mail";
import { totp } from "../tests/support/totp";
import { startInternalAuthTransportWeb } from "./support/internal-auth-transport";

test.skip(process.env.AUTH_TRANSPORT_E2E !== "1", "Requires the isolated real-Auth transport harness");
const baseURL = "http://127.0.0.1:3103";
test.use({ baseURL });
let harness: Awaited<ReturnType<typeof startInternalAuthTransportWeb>>;
test.beforeAll(async () => { harness = await startInternalAuthTransportWeb(196, baseURL); });
test.afterAll(async () => { await harness?.close(); });

async function english(context: BrowserContext) {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
}
async function logIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
}
async function session(context: BrowserContext) {
  const cookies = (await context.cookies()).filter(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)).sort((a, b) => a.name.localeCompare(b.name));
  const data = JSON.parse(Buffer.from(cookies.map(cookie => cookie.value).join("").slice(7), "base64url").toString());
  const claims = JSON.parse(Buffer.from(data.access_token.split(".")[1], "base64url").toString());
  return { id: claims.session_id, aal: claims.aal };
}
async function cookieDigests(context: BrowserContext) {
  return (await context.cookies()).filter(cookie => cookie.name.startsWith("sb-")).map(({ name, value }) => ({ name, digest: createHash("sha256").update(value).digest("hex") }));
}
async function recoveryEmail(page: Page, email: string) {
  await page.goto("/password/forgot");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Send recovery email" }).click();
  await expect(page.getByRole("status")).toContainText("If an account uses this email");
  const mail = await capturedRecoveryEmail(harness.mailpit, email);
  expect(mail.url.origin).toBe(baseURL);
  expect(mail.url.toString()).not.toContain(harness.gateway.url);
  return mail;
}
async function createCompany(page: Page, name: string) {
  await page.getByLabel("Company name").fill(name);
  const ico = String(Date.now()).slice(-8);
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
  await page.getByRole("link", { name: "Continue to Company" }).click();
  await expect(page).toHaveURL(`${baseURL}/companies/${companyId}`);
  return companyId;
}

test("public Invitation emails onboard new and existing Users and retain the wrong-account session after private logout refusal", async ({ browser, context, page }) => {
  await english(context);
  const password = "Invitation-transport-password";
  const administratorEmail = `invitation-admin-${crypto.randomUUID()}@example.test`;
  await provisionBrowserAccountFixture({ email: administratorEmail, password, organizationName: "Internal Invitation transport" });
  await logIn(page, administratorEmail, password);
  await expect(page).toHaveURL(`${baseURL}/`);
  await page.goto("/companies/new");
  const companyName = `Transport Invitation ${Date.now()}`;
  const companyId = await createCompany(page, companyName);
  for (const existing of [false, true]) {
    const email = `invitation-${crypto.randomUUID()}@example.test`;
    if (existing) await provisionBrowserAccountFixture({ email, password, organizationName: "Existing transport User" });
    await page.goto(`/companies/${companyId}/members`);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Invite user", exact: true }).click();
    const mail = await capturedNativeEmail(harness.mailpit, email);
    const href = [...mail.html.matchAll(/href="([^"]+)"/g)].map(match => match[1].replaceAll("&amp;", "&")).find(value => value.includes("/invitations/accept"));
    if (!href) throw new Error("Public Invitation email link missing");
    const link = new URL(href);
    expect(link.origin).toBe(baseURL);
    expect(link.search).toBe("");
    expect(link.toString()).not.toContain(harness.gateway.url);
    const visitor = await browser.newContext();
    await english(visitor);
    const invited = await visitor.newPage();
    await invited.goto(link.toString());
    await expect(invited.getByRole("heading", { name: existing ? "Log in to accept" : "Set your password", exact: true })).toBeVisible();
    await invited.reload();
    await expect(invited.getByRole("button", { name: "Accept invitation", exact: true })).toBeVisible();
    expect(await cookieDigests(visitor)).toEqual([]);
    harness.gateway.unavailable(true, "/auth/v1/token");
    await invited.getByLabel(existing ? "Password" : "New password", { exact: true }).fill(password);
    await invited.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await expect(invited.getByRole("main").getByRole("alert")).toContainText("Session verification is temporarily unavailable");
    expect(await cookieDigests(visitor)).toEqual([]);
    harness.gateway.unavailable(false);
    await invited.getByLabel(existing ? "Password" : "New password", { exact: true }).fill(password);
    await invited.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await expect(invited).toHaveURL(`${baseURL}/companies/${companyId}`);
    await expect(invited.getByRole("navigation", { name: "Company navigation" })).toBeVisible();
    await invited.goto(link.toString());
    await expect(invited.getByRole("main").getByRole("alert")).toContainText("already been used");
    await visitor.close();
  }
  // A different signed-in User can sign out locally only after native success.
  const wrongEmail = `wrong-invitation-${crypto.randomUUID()}@example.test`;
  await page.goto(`/companies/${companyId}/members`);
  await page.getByLabel("Email", { exact: true }).fill(wrongEmail);
  await page.getByRole("button", { name: "Invite user", exact: true }).click();
  const mail = await capturedNativeEmail(harness.mailpit, wrongEmail);
  const href = [...mail.html.matchAll(/href="([^"]+)"/g)].map(match => match[1].replaceAll("&amp;", "&")).find(value => value.includes("/invitations/accept"))!;
  await page.goto(href);
  const before = await cookieDigests(context);
  harness.gateway.unavailable(true, "/auth/v1/logout");
  await page.getByRole("button", { name: "Sign out and continue", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Session verification is temporarily unavailable");
  expect(await cookieDigests(context)).toEqual(before);
  harness.gateway.unavailable(false);
  await page.getByRole("button", { name: "Sign out and continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Set your password", exact: true })).toBeVisible();
  expect(await cookieDigests(context)).toEqual([]);
  const logs = readFileSync(harness.logPath, "utf8");
  for (const secret of [password, new URL(href).hash.slice(7)]) expect(logs.includes(secret)).toBe(false);
});

test("public native recovery mail supports password reset and native MFA replacement through private transport with truthful localized outages", async ({ browser, context, page }) => {
  await english(context);
  const email = `mfa-recovery-${crypto.randomUUID()}@example.test`;
  const password = "Recovery-transport-original-password";
  await provisionBrowserAccountFixture({ email, password, organizationName: "Recovery transport" });
  await logIn(page, email, password);
  await expect(page).toHaveURL(`${baseURL}/`);
  await page.goto("/companies/new");
  const companyId = await createCompany(page, "Recovery Transport Company");
  // Ordinary recovery first, using the real mail and current native session.
  const first = await recoveryEmail(page, email);
  await page.goto(first.url.toString());
  harness.gateway.unavailable(true, "/auth/v1/verify");
  await page.getByRole("button", { name: "Verify recovery email", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Session verification is temporarily unavailable");
  harness.gateway.unavailable(false);
  await page.getByRole("button", { name: "Verify recovery email", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/password/reset`);
  const ordinary = await session(context);
  const recoveredPassword = "Recovered-transport-password";
  await page.getByLabel("New password", { exact: true }).fill(recoveredPassword);
  await page.getByLabel("Confirm new password", { exact: true }).fill(recoveredPassword);
  await page.getByRole("button", { name: "Save new password", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Your password has been changed");
  expect(await session(context)).toEqual(ordinary);
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Your password has been changed");
  await page.goto("/mfa/enroll");
  await page.getByRole("button", { name: "Start setup", exact: true }).click();
  const oldSecret = await page.locator("code").innerText();
  await page.getByLabel("Authenticator code", { exact: true }).fill(totp(oldSecret));
  await page.getByRole("button", { name: "Verify and enable", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes", exact: true })).toBeVisible();
  const codes = await page.locator(".recovery-codes code").allTextContents();
  expect(codes).toHaveLength(10);
  const recoveryContext = await browser.newContext();
  await english(recoveryContext);
  const recovery = await recoveryContext.newPage();
  const mail = await recoveryEmail(recovery, email);
  const scanner = await browser.newContext();
  await english(scanner);
  const scan = await scanner.newPage();
  await scan.goto(mail.url.toString());
  await scan.reload();
  await expect(scan.getByRole("button", { name: "Verify recovery email", exact: true })).toBeVisible();
  expect(await cookieDigests(scanner)).toEqual([]);
  await recovery.goto(mail.url.toString());
  await recovery.getByRole("button", { name: "Verify recovery email", exact: true }).click();
  await expect(recovery).toHaveURL(`${baseURL}/password/reset`);
  expect((await session(recoveryContext)).aal).toBe("aal1");
  await recovery.getByText("Lost your authenticator?", { exact: true }).click();
  await recovery.getByLabel("Recovery code", { exact: true }).fill(codes[0]);
  await recovery.getByRole("checkbox").check();
  await recovery.getByRole("button", { name: "Use backup code", exact: true }).click();
  await expect(recovery.getByRole("status")).toContainText("Recovery is restricted");
  const continuation = (await recoveryContext.cookies()).find(cookie => cookie.name === "ivat_mfa_recovery")!;
  expect(continuation.httpOnly).toBe(true);
  await page.goto(`/companies/${companyId}`);
  await expect(page).toHaveURL(`${baseURL}/password/reset`);
  harness.gateway.unavailable(true, "/auth/v1/admin/users/");
  await recovery.getByRole("button", { name: "Set up replacement authenticator", exact: true }).click();
  await expect(recovery.getByRole("main").getByRole("alert")).toContainText("Session verification is temporarily unavailable");
  await recovery.getByRole("button", { name: "Čeština", exact: true }).click();
  await expect(recovery.getByRole("heading", { name: "Nastavení nového hesla", exact: true })).toBeVisible();
  await recovery.getByRole("button", { name: "Nastavit náhradní autentizátor", exact: true }).click();
  await expect(recovery.getByRole("main").getByRole("alert")).toContainText("Ověření přihlášení je dočasně nedostupné");
  await recovery.getByRole("button", { name: "English", exact: true }).click();
  await expect(recovery.getByRole("button", { name: "Set up replacement authenticator", exact: true })).toBeVisible();
  harness.gateway.unavailable(false);
  await recovery.getByRole("button", { name: "Set up replacement authenticator", exact: true }).click();
  const newSecret = await recovery.locator("code").innerText();
  await recovery.getByLabel("Authenticator code", { exact: true }).fill(totp(newSecret));
  await recovery.getByRole("button", { name: "Verify replacement authenticator", exact: true }).click();
  await expect(recovery.getByRole("heading", { name: "Finish account recovery", exact: true })).toBeVisible();
  const elevated = await session(recoveryContext);
  expect(elevated.aal).toBe("aal2");
  harness.gateway.unavailable(true, "/auth/v1/logout");
  const newPassword = "Restored-MFA-transport-password";
  await recovery.getByLabel("New password", { exact: true }).fill(newPassword);
  await recovery.getByLabel("Confirm new password", { exact: true }).fill(newPassword);
  await recovery.getByRole("button", { name: "Finish recovery", exact: true }).click();
  await expect(recovery.getByRole("main").getByRole("alert")).toContainText("Session verification is temporarily unavailable");
  expect(await session(recoveryContext)).toEqual(elevated);
  expect((await recoveryContext.cookies()).find(cookie => cookie.name === "ivat_mfa_recovery")?.value === continuation.value).toBe(true);
  await recovery.goto(`/companies/${companyId}`);
  await expect(recovery).toHaveURL(`${baseURL}/password/reset`);
  harness.gateway.unavailable(false);
  await recovery.getByRole("button", { name: "Finish recovery", exact: true }).click();
  await expect(recovery.getByRole("status")).toContainText("Your password has been changed");
  expect(await session(recoveryContext)).toEqual(elevated);
  expect((await recoveryContext.cookies()).find(cookie => cookie.name === "ivat_mfa_recovery")).toBeUndefined();
  await recovery.goto(`/companies/${companyId}`);
  await expect(recovery.getByRole("navigation", { name: "Company navigation" })).toBeVisible();
  const loginContext = await browser.newContext();
  await english(loginContext);
  const login = await loginContext.newPage();
  await logIn(login, email, newPassword);
  await expect(login).toHaveURL(`${baseURL}/mfa/verify`);
  await login.getByLabel("Authenticator code", { exact: true }).fill(totp(newSecret, Date.now() + 30_000));
  await login.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(login).toHaveURL(`${baseURL}/`);
  await login.goto(`/companies/${companyId}`);
  await expect(login.getByRole("navigation", { name: "Company navigation" })).toBeVisible();
  const logs = readFileSync(harness.logPath, "utf8");
  for (const secret of [password, recoveredPassword, newPassword, codes[0], oldSecret, newSecret, continuation.value, first.requestToken, first.tokenHash, mail.requestToken, mail.tokenHash]) {
    expect(logs.includes(secret)).toBe(false);
  }
  await Promise.all([recoveryContext.close(), scanner.close(), loginContext.close()]);
});
