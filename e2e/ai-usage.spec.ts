import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  assignBrowserAiConfigurationFixture,
  promoteBrowserSuperAdminFixture,
  recordBrowserAiUsageFixture,
} from "../tests/support/e2e";

const password = "Playwright-password-128";

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
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

async function signUpWithCompany(page: Page, run: string) {
  const email = `ai-usage-${run}@example.test`;
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Usage Organization ${run}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Company name").fill(`Usage Company ${run}`);
  const digits = Date.now().toString().slice(-8);
  await page.getByLabel("IČO").fill(digits);
  await page.getByLabel("VAT ID").fill(`CZ${digits}`);
  await page.getByLabel("Street name").fill("Na Příkopě");
  await page.getByLabel("House number").fill("1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/setup\/filing-frequency$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];
  return { companyId, email };
}

async function enrollSuperAdmin(page: Page, email: string) {
  await promoteBrowserSuperAdminFixture(email);
  await page.reload();
  await expect(page).toHaveURL(/\/mfa\/enroll$/);
  await page.getByRole("button", { name: "Start setup" }).click();
  const secret = await page.locator("code").textContent();
  if (!secret) throw new Error("MFA enrollment did not expose a setup key");
  await page.getByLabel("Authenticator code").fill(authenticatorCode(secret));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await page.getByRole("link", { name: "I saved the codes" }).click();
}

test("SuperAdmin prices models and filters and groups AI usage with its cost", async ({
  baseURL,
  context,
  page,
}) => {
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  await page.setViewportSize({ width: 1440, height: 900 });
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { companyId, email } = await signUpWithCompany(page, run);
  const configuration = await assignBrowserAiConfigurationFixture(companyId);
  await enrollSuperAdmin(page, email);

  await page.goto("/platform/ai-settings");
  const card = page.locator(`#configuration-${configuration.configurationId}`);
  await card.locator("summary").filter({ hasText: "Model prices" }).click();
  const prices = card.getByRole("form", { name: `Model prices of ${configuration.label}` });
  await prices.getByLabel("fake-split: input price (USD / 1M tokens)").fill("2");
  await prices.getByLabel("fake-split: output price (USD / 1M tokens)").fill("8");
  await prices.getByRole("button", { name: "Save prices" }).click();
  await expect(async () => {
    await page.reload();
    await card.locator("summary").filter({ hasText: "Model prices" }).click();
    await expect(prices.getByLabel("fake-split: output price (USD / 1M tokens)")).toHaveValue("8", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  // A priced Split (10 USD), two unpriced Extractions and one with a provider-reported cost.
  await recordBrowserAiUsageFixture(companyId, [
    { model: "fake-split", operation: "split", inputTokens: 1_000_000, outputTokens: 1_000_000 },
    { model: "fake-extract", operation: "extract", inputTokens: 1_000, outputTokens: 0 },
    { model: "fake-extract", operation: "extract", inputTokens: 1_000, outputTokens: 0 },
    { model: "fake-extract", operation: "extract", inputTokens: 1_000, outputTokens: 0, providerCostUsd: 0.5 },
  ]);

  await page.goto("/platform/ai-usage");
  const filters = page.getByRole("form", { name: "AI usage filters" });
  await filters.getByLabel("Company", { exact: true }).selectOption({ label: `Usage Organization ${run} · Usage Company ${run}` });
  await filters.getByLabel("Group by").selectOption({ label: "Model" });
  await filters.getByRole("button", { name: "Filter" }).click();
  const usage = page.getByRole("region", { name: "Platform AI usage" });
  await expect(usage.getByRole("columnheader").first()).toHaveText("Model");
  await expect(usage.getByRole("row").nth(1).getByRole("cell")).toHaveText([
    "fake-extract", "3", "3,000", "0", "$0.50", "2",
  ]);
  await expect(usage.getByRole("row").nth(2).getByRole("cell")).toHaveText([
    "fake-split", "1", "1,000,000", "1,000,000", "$10.00", "0",
  ]);
  await expect(usage.getByRole("row").nth(3).getByRole("cell")).toHaveText([
    "Total", "4", "1,003,000", "1,000,000", "$10.50", "2",
  ]);

  await filters.getByLabel("Operation", { exact: true }).selectOption({ label: "Extraction" });
  await filters.getByLabel("Group by").selectOption({ label: "Operation" });
  await filters.getByRole("button", { name: "Filter" }).click();
  await expect(usage.getByRole("columnheader").first()).toHaveText("Operation");
  await expect(usage.getByRole("row")).toHaveCount(3);
  await expect(usage.getByRole("row").nth(1).getByRole("cell")).toHaveText([
    "Extraction", "3", "3,000", "0", "$0.50", "2",
  ]);
});
