import { provisionAndLogIn } from "./support/accounts";
import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { promoteBrowserSuperAdminFixture } from "../tests/support/e2e";

const password = "Playwright-password-102";

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

async function expectFocusedJourney(page: Page, heading: string) {
  await expect(page.getByRole("banner").getByRole("link", { name: "iVAT" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("heading", { name: heading, level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: /Company|Organization|Platform/ })).toHaveCount(0);
}

test("login presents the shared brand as a focused authentication journey", async ({ baseURL, context, page }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);

  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/login");

  await expect(page.getByRole("banner").getByRole("link", { name: "iVAT" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("heading", { name: "Log in", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: /Company|Organization|Platform/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.getByLabel("Email").focus();
  expect(await page.getByLabel("Email").evaluate((input) => getComputedStyle(input).outlineStyle)).not.toBe("none");
});

test("an invalid invitation keeps the focused brand and explains the refusal accessibly", async ({ baseURL, context, page }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);

  await page.goto("/invitations/accept?token=invalid");

  await expect(page.getByRole("banner").getByRole("link", { name: "iVAT" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("heading", { name: "Accept invitation", level: 1 })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "This invitation link is invalid" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: /Company|Organization|Platform/ })).toHaveCount(0);
});

test("login errors and locale changes remain accessible on a narrow screen", async ({ baseURL, context, page }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/login");
  await page.getByLabel("Email").fill("missing@example.test");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Wrong email or password" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue("missing@example.test");

  await page.goto("/login");
  await expectFocusedJourney(page, "Log in");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  await page.getByRole("button", { name: "Čeština" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Přihlášení", level: 1 })).toBeVisible();
});

test("account security, MFA enrollment and verification stay focused at desktop and mobile widths", async ({
  baseURL,
  context,
  page,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `auth-shell-${run}@example.test`;

  await provisionAndLogIn(page, { organizationName: `Auth Shell ${run}`, email, password });
  await expect(page).toHaveURL(/\/companies\/new$/);

  await page.goto("/settings/security");
  await expectFocusedJourney(page, "Security");
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByRole("link", { name: "Enable authenticator" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);

  await page.getByRole("link", { name: "Enable authenticator" }).click();
  await expect(page).toHaveURL(/\/mfa\/enroll$/);
  await expectFocusedJourney(page, "Set up two-factor authentication");
  await page.getByRole("button", { name: "Start setup" }).click();
  const secret = await page.locator("code").textContent();
  if (!secret) throw new Error("MFA enrollment did not expose a setup key");
  await page.getByLabel("Authenticator code").fill(authenticatorCode(secret));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes", level: 2 })).toBeVisible();
  await page.getByRole("link", { name: "I saved the codes" }).click();
  await promoteBrowserSuperAdminFixture(email);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/companies/new");
  const logOut = page.getByRole("button", { name: "Log out" });
  await expect(logOut).toBeVisible();
  await logOut.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/mfa\/verify$/);
  await expectFocusedJourney(page, "Two-factor verification");
  await page.getByLabel("Authenticator code").fill("000000");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "verification code is invalid" })).toBeVisible();
});
