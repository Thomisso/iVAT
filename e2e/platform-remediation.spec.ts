import { provisionAndLogIn } from "./support/accounts";
import { createHmac } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  addBrowserMissingConfigurationIssueFixture,
  addBrowserTerminalProcessingJobFixture,
  browserRemediationAuditActions,
  browserSourceFileStatus,
  promoteBrowserSuperAdminFixture,
} from "../tests/support/e2e";

const password = "Playwright-password-112";

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

async function english(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
}

async function provisionCompanyAdministrator(page: Page, run: string) {
  const email = `platform-remediation-${run}@example.test`;
  await provisionAndLogIn(page, { organizationName: `Remediation Organization ${run}`, email, password });
  await page.getByLabel("Company name").fill(`Remediation Company ${run}`);
  const ico = Date.now().toString().slice(-8);
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
  await page.goto(`/companies/${companyId}`);
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

async function uploadReceipt(page: Page, companyId: string) {
  await page.goto(`/companies/${companyId}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/receipt.jpg");
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page).toHaveURL(/\/upload-batches\/[0-9a-f-]+$/);
}

async function waitForHealthyDashboard(page: Page) {
  await expect.poll(async () => {
    await page.reload();
    return Promise.all([
      page.getByText("No active operational problems.").count(),
      page.getByRole("link", { name: "Platform alerts, 0 unresolved" }).count(),
    ]);
  }, { timeout: 45_000 }).toEqual([1, 1]);
}

test("SuperAdmin resolves live Platform alerts in place without mixing Company notifications", async ({
  baseURL,
  context,
  page,
}) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { companyId, email } = await provisionCompanyAdministrator(page, run);
  await uploadReceipt(page, companyId);
  await expect(page.getByRole("heading", { name: "Waiting for AI setup" })).toBeVisible();
  await addBrowserMissingConfigurationIssueFixture(companyId);
  await enrollSuperAdmin(page, email);

  await page.goto("/platform/administration");
  const configurationProblem = page.locator(".operational-problem").filter({ hasText: "AI Configuration missing" });
  await expect(configurationProblem).toBeVisible();
  await expect(page.getByRole("link", { name: /Platform overview.*1 unresolved operational alert/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Platform alerts, 1 unresolved" })).toBeVisible();
  await expect(page.getByRole("button", { name: /upload notification/i })).toHaveCount(0);

  const createConfiguration = configurationProblem.locator("summary").filter({
    hasText: "Create an AI Configuration",
  });
  if (await createConfiguration.count()) {
    await createConfiguration.click();
    await configurationProblem.getByLabel("Configuration label").fill(`Browser repair ${run}`);
    await configurationProblem.getByLabel("Provider", { exact: true }).selectOption("fake");
    await configurationProblem.getByLabel("Split model").fill("fake-split");
    await configurationProblem.getByLabel("Extract model").fill("fake-extract");
    await configurationProblem.getByLabel("Provider credential").fill("browser-remediation-secret");
    await configurationProblem.getByRole("button", { name: "Create configuration" }).click();
  }

  const refreshedConfigurationProblem = page.locator(".operational-problem").filter({
    hasText: "AI Configuration missing",
  });
  await expect(refreshedConfigurationProblem.getByRole("button", { name: "Assign" })).toBeVisible();
  await refreshedConfigurationProblem.getByRole("button", { name: "Assign" }).click();
  await waitForHealthyDashboard(page);

  await page.goto(`/platform/ai-settings#company-${companyId}`);
  const companyAssignment = page.locator(`#company-${companyId}`);
  await companyAssignment.getByLabel("Lifetime successful-Extraction allowance").fill("0");
  await companyAssignment.getByRole("button", { name: "Save allowance" }).click();
  await uploadReceipt(page, companyId);

  await page.goto("/platform/administration");
  const allowanceProblem = page.locator(".operational-problem").filter({ hasText: "Processing allowance exhausted" });
  await expect(allowanceProblem).toBeVisible({ timeout: 45_000 });
  await allowanceProblem.getByRole("checkbox", { name: "Unlimited processing" }).check();
  await allowanceProblem.getByRole("button", { name: "Save allowance" }).click();
  await waitForHealthyDashboard(page);

  const terminal = await addBrowserTerminalProcessingJobFixture(companyId);
  await page.reload();
  const terminalProblem = page.locator(".operational-problem").filter({ hasText: "Terminal processing job" });
  await expect(terminalProblem).toBeVisible();
  await terminalProblem.getByRole("button", { name: "Retry" }).click();
  await expect.poll(
    async () => browserSourceFileStatus(terminal.sourceFileId),
    { timeout: 45_000 },
  ).toBe("split");
  await waitForHealthyDashboard(page);

  await expect.poll(async () => browserRemediationAuditActions([companyId, terminal.jobId])).toEqual(
    expect.arrayContaining([
      "company.ai_configuration_assigned",
      "company.ai_processing_allowance_changed",
      "processing.job_retried",
    ]),
  );
});
