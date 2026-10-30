import { expect, test } from "@playwright/test";

for (const locale of ["cs", "en"] as const) {
  test(`public registration is closed and Google availability is truthful in ${locale}`, async ({ baseURL, context, page, request }) => {
    if (!baseURL) throw new Error("Browser base URL missing");
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: new URL(baseURL).origin }]);
    await page.goto("/login");
    await expect(page.getByRole("link", { name: locale === "cs" ? "Zaregistrujte se" : "Sign up", exact: true })).toHaveCount(0);
    const configuredGoogle = process.env.TEST_GOOGLE_CONFIGURED === "1";
    await expect(page.getByRole("button", { name: locale === "cs" ? "Pokračovat přes Google" : "Continue with Google", exact: true })).toHaveCount(configuredGoogle ? 1 : 0);
    await expect(page.getByText(locale === "cs" ? "nebo" : "or", { exact: true })).toHaveCount(configuredGoogle ? 1 : 0);
    await page.goto("/signup");
    await expect(page).toHaveURL(/\/login\?error=registration_closed$/);
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(locale === "cs"
      ? "Veřejná registrace je uzavřena. Přihlaste se nebo použijte pozvánku od administrátora."
      : "Public registration is closed. Sign in or use an invitation from your administrator.");
    await expect(page.getByLabel(locale === "cs" ? "Název organizace" : "Organization name", { exact: true })).toHaveCount(0);
    const refused = await request.post("/signup", { form: { email: `public-${crypto.randomUUID()}@example.test`, password: "Public-signup-password-161", organizationName: "Unrequested Organization" }, maxRedirects: 0 });
    expect(refused.status()).toBe(307);
    expect(refused.headers().location).toBe("/login?error=registration_closed");
  });
}
