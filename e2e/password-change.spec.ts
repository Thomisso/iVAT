import { expect, test, type BrowserContext } from "@playwright/test";
import { provisionAndLogIn } from "./support/accounts";
import { totp } from "../tests/support/totp";

async function session(context: BrowserContext) {
  const chunks = (await context.cookies()).filter(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)).sort((a, b) => a.name.localeCompare(b.name));
  const encoded = chunks.map(chunk => chunk.value).join("");
  const data = JSON.parse(Buffer.from(encoded.slice("base64-".length), "base64url").toString());
  const claims = JSON.parse(Buffer.from(data.access_token.split(".")[1], "base64url").toString());
  return { accessToken: data.access_token, refreshToken: data.refresh_token, sessionId: claims.session_id, aal: claims.aal };
}

for (const locale of ["en", "cs"] as const) {
  for (const mfa of [false, true]) {
    test(`${locale} password change preserves ${mfa ? "AAL2" : "normal"} browser session`, async ({ baseURL, context, page }) => {
      if (!baseURL) throw new Error("Browser base URL missing");
      const password = "Browser-original-password-165";
      const newPassword = "Browser-changed-password-165";
      await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
      await provisionAndLogIn(page, { email: `password-${crypto.randomUUID()}@example.test`, password, organizationName: "Password change" });
      if (mfa) {
        await page.goto("/mfa/enroll");
        await page.getByRole("button", { name: "Start setup" }).click();
        const secret = await page.locator("code").textContent();
        if (!secret) throw new Error("Missing Auth setup secret");
        await page.getByLabel("Authenticator code").fill(totp(secret));
        await page.getByRole("button", { name: "Verify and enable" }).click();
        await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
      }
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: new URL(baseURL).origin }]);
      await page.goto("/settings/security");
      const current = page.getByLabel(locale === "en" ? "Current password" : "Současné heslo", { exact: true });
      const next = page.getByLabel(locale === "en" ? "New password" : "Nové heslo", { exact: true });
      const confirmation = page.getByLabel(locale === "en" ? "Confirm new password" : "Potvrzení nového hesla", { exact: true });
      const submit = page.getByRole("button", { name: locale === "en" ? "Change password" : "Změnit heslo", exact: true });
      await expect(current).toBeVisible();
      const before = await session(context);
      expect(before.aal).toBe(mfa ? "aal2" : "aal1");
      await current.fill("incorrect-password");
      await next.fill(newPassword);
      await confirmation.fill(newPassword);
      await submit.click();
      await expect(page.getByRole("alert").filter({ hasText: locale === "en" ? "current password is incorrect" : "Současné heslo není správné" })).toBeVisible();
      expect(await session(context)).toEqual(before);
      await expect(current).toHaveValue("");
      await expect(next).toHaveValue("");
      await expect(confirmation).toHaveValue("");
      await current.fill(password);
      await next.fill(newPassword);
      await confirmation.fill(newPassword);
      await submit.click();
      await expect(page.getByRole("status").filter({ hasText: locale === "en" ? "Password changed" : "Heslo bylo změněno" })).toBeVisible();
      expect(await session(context)).toEqual(before);
      await page.reload();
      await expect(current).toBeVisible();
      if (mfa) await expect(page.getByText(locale === "en" ? "Two-factor authentication is enabled." : "Dvoufázové ověření je zapnuté.", { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 360, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    });
  }
}
