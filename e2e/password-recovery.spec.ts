import { expect, test, type BrowserContext } from "@playwright/test";
import { provisionBrowserAccountFixture } from "../tests/support/e2e";
import { capturedRecoveryEmail } from "../tests/support/recovery-mail";
import { provisionAndLogIn } from "./support/accounts";
import { totp } from "../tests/support/totp";

async function currentSession(context: BrowserContext) {
  const encoded = (await context.cookies()).filter(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name))
    .sort((a, b) => a.name.localeCompare(b.name)).map(cookie => cookie.value).join("");
  const data = JSON.parse(Buffer.from(encoded.slice("base64-".length), "base64url").toString());
  const claims = JSON.parse(Buffer.from(data.access_token.split(".")[1], "base64url").toString());
  return { sessionId: claims.session_id, aal: claims.aal };
}

for (const locale of ["en", "cs"] as const) {
  for (const mfa of [false, true]) {
    test(`${locale} native email recovery preserves ${mfa ? "TOTP" : "normal"} access and scanner-safe links`, async ({ baseURL, browser, context, page }) => {
      if (!baseURL || !process.env.MAILPIT_URL) throw new Error("Browser URL and local Mailpit are required");
      const email = `recovery-${crypto.randomUUID()}@example.test`;
      const password = "Browser-original-password-167";
      const newPassword = "Browser-recovered-password-167";
      const account = { email, password, organizationName: "Password recovery" };
      let secret = "";
      await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
      if (mfa) {
        await provisionAndLogIn(page, account);
        await page.goto("/mfa/enroll");
        await page.getByRole("button", { name: "Start setup" }).click();
        secret = await page.locator("code").innerText();
        await page.getByLabel("Authenticator code").fill(totp(secret));
        await page.getByRole("button", { name: "Verify and enable" }).click();
        await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
        await page.goto("/companies/new");
        await page.getByRole("button", { name: "Log out", exact: true }).click();
        await expect(page).toHaveURL(/\/login$/);
      } else await provisionBrowserAccountFixture(account);
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: new URL(baseURL).origin }]);
      await page.goto("/login");
      await page.getByRole("link", { name: locale === "en" ? "Forgot password?" : "Zapomenuté heslo?" }).click();
      await expect(page.getByRole("heading", { name: locale === "en" ? "Recover your password" : "Obnova hesla", exact: true })).toBeVisible();
      await page.getByLabel(locale === "en" ? "Email" : "E-mail", { exact: true }).fill(email);
      await page.getByRole("button", { name: locale === "en" ? "Send recovery email" : "Odeslat e-mail pro obnovu" }).click();
      const response = await page.getByRole("status").innerText();
      expect(response).toContain(locale === "en" ? "If an account uses this email" : "Pokud tento e-mail patří k účtu");
      await page.goto("/password/forgot");
      await page.getByLabel(locale === "en" ? "Email" : "E-mail", { exact: true }).fill(`unknown-${crypto.randomUUID()}@example.test`);
      await page.getByRole("button", { name: locale === "en" ? "Send recovery email" : "Odeslat e-mail pro obnovu" }).click();
      await expect(page.getByRole("status")).toHaveText(response);
      const message = await capturedRecoveryEmail(process.env.MAILPIT_URL, email);
      expect(message.url.origin).toBe(new URL(baseURL).origin);
      expect(message.url.search).toBe("");
      const scanner = await browser.newContext();
      await scanner.addCookies([{ name: "NEXT_LOCALE", value: locale, url: new URL(baseURL).origin }]);
      const scannerPage = await scanner.newPage();
      await scannerPage.goto(message.url.toString());
      const verifyLabel = locale === "en" ? "Verify recovery email" : "Ověřit e-mail pro obnovu";
      await expect(scannerPage.getByRole("button", { name: verifyLabel })).toBeVisible();
      await scannerPage.reload();
      await expect(scannerPage.getByRole("button", { name: verifyLabel })).toBeVisible();
      expect((await scanner.cookies()).filter(cookie => cookie.name.startsWith("sb-"))).toEqual([]);
      await page.goto(message.url.toString());
      await page.getByRole("button", { name: verifyLabel }).click();
      await expect(page).toHaveURL(new URL("/password/reset", baseURL).toString());
      if (mfa) {
        await expect(page.getByText(locale === "en" ? "Enter a code from your existing authenticator." : "Zadejte kód ze svého stávajícího autentizátoru.", { exact: false })).toBeVisible();
        expect((await currentSession(context)).aal).toBe("aal1");
        await page.getByLabel(locale === "en" ? "Authenticator code" : "Kód z autentizátoru").fill(totp(secret));
        await page.getByRole("button", { name: locale === "en" ? "Verify authenticator" : "Ověřit autentizátor" }).click();
      }
      const newPasswordField = page.getByLabel(locale === "en" ? "New password" : "Nové heslo", { exact: true });
      await expect(newPasswordField).toBeVisible();
      const before = await currentSession(context);
      expect(before.aal).toBe(mfa ? "aal2" : "aal1");
      await newPasswordField.fill(newPassword);
      const confirmationField = page.getByLabel(locale === "en" ? "Confirm new password" : "Potvrzení nového hesla", { exact: true });
      await confirmationField.fill("Different-confirmation-167");
      await page.getByRole("button", { name: locale === "en" ? "Save new password" : "Uložit nové heslo" }).click();
      await expect(page.getByRole("alert").filter({ hasText: locale === "en" ? "new passwords do not match" : "Nová hesla se neshodují" })).toBeVisible();
      await expect(newPasswordField).toHaveValue("");
      await expect(confirmationField).toHaveValue("");
      expect(await currentSession(context)).toEqual(before);
      await newPasswordField.fill(newPassword);
      await confirmationField.fill(newPassword);
      await page.getByRole("button", { name: locale === "en" ? "Save new password" : "Uložit nové heslo" }).click();
      await expect(page.getByRole("status")).toContainText(locale === "en" ? "Your password has been changed" : "Heslo bylo změněno");
      expect(await currentSession(context)).toEqual(before);
      await page.reload();
      await expect(page.getByRole("status")).toContainText(locale === "en" ? "Your password has been changed" : "Heslo bylo změněno");
      await scannerPage.reload();
      await expect(scannerPage.getByRole("alert").filter({ hasText: locale === "en" ? "already been used" : "už byl použit" })).toBeVisible();
      await expect(scannerPage.getByRole("link", { name: locale === "en" ? "Request a new recovery email" : "Vyžádat nový e-mail pro obnovu" })).toBeVisible();
      await page.setViewportSize({ width: 360, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      await scanner.close();
    });
  }
}
