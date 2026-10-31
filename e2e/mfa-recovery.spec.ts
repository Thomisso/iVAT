import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { provisionAndLogIn } from "./support/accounts";
import { capturedRecoveryEmail } from "../tests/support/recovery-mail";
import { totp } from "../tests/support/totp";

async function session(context: BrowserContext) {
  const encoded = (await context.cookies()).filter(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name))
    .sort((a, b) => a.name.localeCompare(b.name)).map(cookie => cookie.value).join("");
  const data = JSON.parse(Buffer.from(encoded.slice("base64-".length), "base64url").toString());
  const claims = JSON.parse(Buffer.from(data.access_token.split(".")[1], "base64url").toString());
  return { sessionId: claims.session_id as string, aal: claims.aal as string, accessToken: data.access_token as string };
}

async function locale(context: BrowserContext, baseURL: string, value: "en" | "cs") {
  await context.addCookies([{ name: "NEXT_LOCALE", value, url: new URL(baseURL).origin }]);
}

async function preparedAccount(page: Page, context: BrowserContext, baseURL: string) {
  await locale(context, baseURL, "en");
  const email = `backup-${crypto.randomUUID()}@example.test`;
  const password = "Browser-original-password-168";
  await provisionAndLogIn(page, { email, password, organizationName: "Backup recovery" });
  await page.getByLabel("Company name").fill("Backup Recovery Company");
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
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/setup/ai-processing$`));
  await page.getByRole("link", { name: "Continue to Company" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));
  await page.goto("/mfa/enroll");
  await page.getByRole("button", { name: "Start setup" }).click();
  const oldSecret = await page.locator("code").innerText();
  await page.getByLabel("Authenticator code").fill(totp(oldSecret));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  const codes = await page.locator(".recovery-codes code").allTextContents();
  expect(codes).toHaveLength(10);
  return { email, password, oldSecret, codes, companyUrl: `/companies/${companyId}` };
}

async function verifyEmail(page: Page, email: string, language: "en" | "cs", previousRequestToken?: string) {
  if (!process.env.MAILPIT_URL) throw new Error("Local Mailpit required");
  let message;
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.goto("/password/forgot");
    await page.getByLabel(language === "en" ? "Email" : "E-mail", { exact: true }).fill(email);
    await page.getByRole("button", { name: language === "en" ? "Send recovery email" : "Odeslat e-mail pro obnovu" }).click();
    await expect(page.getByRole("status")).toContainText(language === "en" ? "If an account uses this email" : "Pokud tento e-mail patří k účtu");
    message = await capturedRecoveryEmail(process.env.MAILPIT_URL, email);
    if (message.requestToken !== previousRequestToken) break;
    // Respect Auth's per-address one-second mail interval before requesting again.
    await new Promise(resolve => setTimeout(resolve, 1100));
  }
  if (!message || message.requestToken === previousRequestToken) throw new Error("Fresh native recovery email required");
  await page.goto(message.url.toString());
  await page.getByRole("button", { name: language === "en" ? "Verify recovery email" : "Ověřit e-mail pro obnovu" }).click();
  await expect(page).toHaveURL(/\/password\/reset$/);
  return message;
}

async function useCode(page: Page, code: string, language: "en" | "cs") {
  await page.getByText(language === "en" ? "Lost your authenticator?" : "Ztracený autentizátor?", { exact: true }).click();
  const field = page.getByLabel(language === "en" ? "Recovery code" : "Obnovovací kód", { exact: true });
  await field.fill("not-a-valid-backup-code");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: language === "en" ? "Use backup code" : "Použít záložní kód" }).click();
  await expect(page.getByRole("alert").filter({ hasText: language === "en" ? "verification code is invalid" : "Ověřovací kód je neplatný" })).toBeVisible();
  await expect(field).toHaveValue("");
  await field.fill(code);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: language === "en" ? "Use backup code" : "Použít záložní kód" }).click();
  await expect(page.getByRole("status")).toContainText(language === "en" ? "Recovery is restricted" : "Relace je omezená");
}

for (const language of ["en", "cs"] as const) {
  test(`${language} email and prepared backup code restore a native authenticator before protected Company access`, async ({ baseURL, browser, context, page }) => {
    if (!baseURL) throw new Error("Browser URL required");
    const account = await preparedAccount(page, context, baseURL);
    const recoveryContext = await browser.newContext();
    await locale(recoveryContext, baseURL, language);
    const recovery = await recoveryContext.newPage();
    const message = await verifyEmail(recovery, account.email, language);
    await useCode(recovery, account.codes[0], language);
    await recovery.setViewportSize({ width: 360, height: 800 });
    expect(await recovery.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await recovery.screenshot({ path: test.info().outputPath(`${language}-restricted.png`), fullPage: true });
    expect((await session(recoveryContext)).aal).toBe("aal1");
    const continuation = (await recoveryContext.cookies()).find(cookie => cookie.name === "ivat_mfa_recovery");
    expect(continuation?.httpOnly).toBe(true);
    expect(continuation?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(await recovery.evaluate(() => document.cookie)).not.toContain("ivat_mfa_recovery");
    await locale(context, baseURL, language);
    await page.goto(account.companyUrl);
    await expect(page).toHaveURL(/\/password\/reset$/);
    await expect(page.getByText(language === "en" ? "Account recovery is in progress." : "Probíhá obnova účtu.", { exact: false })).toBeVisible();
    await recovery.reload();
    await recovery.getByRole("button", { name: language === "en" ? "Set up replacement authenticator" : "Nastavit náhradní autentizátor", exact: true }).click();
    const replacementSecret = await recovery.locator("code").innerText();
    await recovery.reload();
    await recovery.getByLabel(language === "en" ? "Authenticator code" : "Kód z autentizátoru", { exact: true }).fill(totp(replacementSecret));
    await recovery.getByRole("button", { name: language === "en" ? "Verify replacement authenticator" : "Ověřit náhradní autentizátor" }).click();
    await expect(recovery.getByRole("heading", { name: language === "en" ? "Finish account recovery" : "Dokončení obnovy účtu" })).toBeVisible();
    const elevated = await session(recoveryContext);
    expect(elevated.aal).toBe("aal2");
    await recovery.goto(account.companyUrl);
    await expect(recovery).toHaveURL(/\/password\/reset$/);
    const newPassword = "Browser-restored-password-168";
    await recovery.getByLabel(language === "en" ? "New password" : "Nové heslo", { exact: true }).fill(newPassword);
    await recovery.getByLabel(language === "en" ? "Confirm new password" : "Potvrzení nového hesla", { exact: true }).fill(newPassword);
    await recovery.getByRole("button", { name: language === "en" ? "Finish recovery" : "Dokončit obnovu", exact: true }).click();
    await expect(recovery.getByRole("status")).toContainText(language === "en" ? "Your password has been changed" : "Heslo bylo změněno");
    expect((await session(recoveryContext)).sessionId).toBe(elevated.sessionId);
    expect((await recoveryContext.cookies()).find(cookie => cookie.name === "ivat_mfa_recovery")).toBeUndefined();
    await recovery.goto(account.companyUrl);
    await expect(recovery.getByRole("button", { name: /Backup Recovery Company/ })).toBeVisible();
    await recovery.setViewportSize({ width: 360, height: 800 });
    expect(await recovery.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const loginContext = await browser.newContext();
    await locale(loginContext, baseURL, language);
    const login = await loginContext.newPage();
    await login.goto("/login");
    await login.getByLabel(language === "en" ? "Email" : "E-mail", { exact: true }).fill(account.email);
    await login.getByLabel(language === "en" ? "Password" : "Heslo", { exact: true }).fill(newPassword);
    await login.getByRole("button", { name: language === "en" ? "Log in" : "Přihlásit se", exact: true }).click();
    await expect(login).toHaveURL(/\/mfa\/verify$/);
    await expect(login.getByRole("link", { name: language === "en" ? "Start email recovery" : "Zahájit obnovu přes e-mail" })).toBeVisible();
    await expect(login.getByLabel(language === "en" ? "Recovery code" : "Obnovovací kód", { exact: true })).toHaveCount(0);
    await login.getByLabel(language === "en" ? "Authenticator code" : "Kód z autentizátoru").fill(totp(replacementSecret));
    await login.getByRole("button", { name: language === "en" ? "Verify" : "Ověřit", exact: true }).click();
    await expect(login).not.toHaveURL(/\/mfa\/verify$/);
    await login.goto(account.companyUrl);
    await expect(login.getByRole("button", { name: /Backup Recovery Company/ })).toBeVisible();
    const logs = process.env.IVAT_E2E_SERVICE_LOG_DIRECTORY;
    if (!logs) throw new Error("Service logs required for MFA-secret privacy proof");
    const next = await readFile(path.join(logs, "next.log"), "utf8");
    for (const secret of [account.password, newPassword, account.codes[0], account.oldSecret, replacementSecret, continuation!.value, message.requestToken, message.tokenHash]) expect(next).not.toContain(secret);
    await Promise.all([recoveryContext.close(), loginContext.close()]);
  });
}

test("a fresh email and protected continuation resume after native session loss without reusing the prepared code", async ({ baseURL, browser, context, page }) => {
  if (!baseURL) throw new Error("Browser URL required");
  const account = await preparedAccount(page, context, baseURL);
  const recoveryContext = await browser.newContext();
  await locale(recoveryContext, baseURL, "en");
  const recovery = await recoveryContext.newPage();
  const firstEmail = await verifyEmail(recovery, account.email, "en");
  await useCode(recovery, account.codes[0], "en");
  const continuation = (await recoveryContext.cookies()).find(cookie => cookie.name === "ivat_mfa_recovery")!;
  const current = await session(recoveryContext);
  const environment = parseEnv(await readFile(".env.local", "utf8"));
  if (!environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) throw new Error("Local Auth publishable key required");
  const revoked = await fetch(`${environment.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/logout?scope=local`, {
    method: "POST", headers: { apikey: environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${current.accessToken}` },
  });
  expect(revoked.ok).toBe(true);
  await recoveryContext.clearCookies({ name: /^sb-/ });
  expect((await recoveryContext.cookies()).find(cookie => cookie.name === "ivat_mfa_recovery")?.value).toBe(continuation.value);
  await verifyEmail(recovery, account.email, "en", firstEmail.requestToken);
  await recovery.getByRole("button", { name: "Continue recovery on this device" }).click();
  await expect(recovery.getByRole("status")).toContainText("Recovery is restricted");
  expect((await recoveryContext.cookies()).find(cookie => cookie.name === "ivat_mfa_recovery")?.value).not.toBe(continuation.value);
  await recovery.getByRole("button", { name: "Set up replacement authenticator", exact: true }).click();
  const secret = await recovery.locator("code").innerText();
  await recovery.getByLabel("Authenticator code", { exact: true }).fill(totp(secret));
  await recovery.getByRole("button", { name: "Verify replacement authenticator" }).click();
  await recovery.getByLabel("New password", { exact: true }).fill("Resumed-browser-password-168");
  await recovery.getByLabel("Confirm new password", { exact: true }).fill("Resumed-browser-password-168");
  await recovery.getByRole("button", { name: "Finish recovery", exact: true }).click();
  await expect(recovery.getByRole("status")).toContainText("Your password has been changed");
  await recovery.goto(account.companyUrl);
  await expect(recovery.getByRole("button", { name: /Backup Recovery Company/ })).toBeVisible();
  await recoveryContext.close();
});
