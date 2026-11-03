import { provisionAndLogIn } from "./support/accounts";
import { createHmac } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  addBrowserFailedExportAttemptFixture,
  browserExportAttemptState,
  addBrowserMissingConfigurationIssueFixture,
  addBrowserTerminalProcessingJobFixture,
  addBrowserLaterSplitFailureFixture,
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

async function provisionCompanyAdministrator(page: Page, run: string, companyPrefix = "Remediation Company") {
  const email = `platform-remediation-${run}@example.test`;
  await provisionAndLogIn(page, { organizationName: `Remediation Organization ${run}`, email, password });
  await page.getByLabel("Company name").fill(`${companyPrefix} ${run}`);
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

async function createOwnedConfiguration(page: Page, label: string, provider: "fake" | "openai") {
  await page.goto("/platform/ai-settings");
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Create configuration", exact: true }) });
  await form.getByLabel("Configuration label", { exact: true }).fill(label);
  await form.getByLabel("Provider", { exact: true }).selectOption(provider);
  await form.getByLabel("Split model", { exact: true }).fill("fake-split");
  await form.getByLabel("Extract model", { exact: true }).fill("fake-extract");
  await form.getByLabel("Provider credential", { exact: true }).fill("browser-remediation-fixture");
  await form.getByRole("button", { name: "Create configuration", exact: true }).click();
  const configuration = page.getByRole("article").filter({ has: page.getByRole("heading", { name: label, exact: true }) });
  await expect(configuration).toBeVisible();
  const id = await configuration.getAttribute("id");
  if (!id?.startsWith("configuration-")) throw new Error("Created configuration identity missing");
  return id.slice("configuration-".length);
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
  const firstSourceFileId = await addBrowserMissingConfigurationIssueFixture(companyId);
  await enrollSuperAdmin(page, email);

  const incompatibleId = await createOwnedConfiguration(page, `000 Incompatible remediation ${run}`, "openai");
  const fakeId = await createOwnedConfiguration(page, `ZZZ Owned fake remediation ${run}`, "fake");

  await page.goto("/platform/administration");
  const configurationProblem = page.locator(".operational-problem").filter({ hasText: "AI Configuration missing" });
  await expect(configurationProblem).toBeVisible();
  await expect(page.getByRole("link", { name: /Platform overview.*1 unresolved operational alert/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Platform alerts, 1 unresolved" })).toBeVisible();
  await expect(page.getByRole("button", { name: /upload notification/i })).toHaveCount(0);

  const refreshedConfigurationProblem = page.locator(".operational-problem").filter({
    hasText: "AI Configuration missing",
  });
  await expect(refreshedConfigurationProblem.getByRole("button", { name: "Assign" })).toBeVisible();
  // An incompatible configuration deliberately sorts first. Incidental inventory
  // must never decide which adapter this actual worker workflow exercises.
  await expect(refreshedConfigurationProblem.getByLabel("AI Configuration", { exact: true })).toHaveValue(incompatibleId);
  await refreshedConfigurationProblem.getByLabel("AI Configuration", { exact: true }).selectOption(fakeId);
  await expect(refreshedConfigurationProblem.getByLabel("AI Configuration", { exact: true })).toHaveValue(fakeId);
  await refreshedConfigurationProblem.getByRole("button", { name: "Assign" }).click();
  await expect.poll(() => browserSourceFileStatus(firstSourceFileId), { timeout: 45_000 }).toBe("split");
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

  const manual = await addBrowserTerminalProcessingJobFixture(companyId, "uploaded");
  await page.reload();
  await expect(terminalProblem).toBeVisible();
  await expect(page.getByRole("link", { name: "Platform alerts, 1 unresolved" })).toBeVisible();
  await terminalProblem.getByRole("button", { name: "Take over for manual review", exact: true }).click();
  await expect.poll(() => browserSourceFileStatus(manual.sourceFileId)).toBe("needs_review");
  await waitForHealthyDashboard(page);
  await expect(page.locator("#failed-jobs").getByRole("row").filter({ hasText: manual.sourceFileId })).toHaveCount(0);
  await page.goto(`/companies/${companyId}/source-files/${manual.sourceFileId}`);
  await expect(page.getByRole("button", { name: "Create one Document manually", exact: true })).toBeVisible();

  const later = await addBrowserLaterSplitFailureFixture(manual.sourceFileId);
  await page.goto("/platform/administration");
  await expect(terminalProblem).toBeVisible();
  await expect(page.getByRole("link", { name: "Platform alerts, 1 unresolved" })).toBeVisible();
  await expect(page.locator("#failed-jobs").getByRole("row").filter({ hasText: manual.sourceFileId })).toHaveCount(1);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "cs", url: baseURL }]);
  await page.reload();
  const czechProblem = page.locator(".operational-problem").filter({ hasText: manual.sourceFileId });
  await czechProblem.getByRole("button", { name: "Převzít k ruční kontrole", exact: true }).click();
  await expect.poll(() => browserSourceFileStatus(later.sourceFileId)).toBe("needs_review");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  await page.reload();
  await waitForHealthyDashboard(page);

  const postSplit = await addBrowserTerminalProcessingJobFixture(companyId, "split");
  await page.reload();
  await expect(terminalProblem).toBeVisible();
  await terminalProblem.getByRole("button", { name: "Take over for manual review", exact: true }).click();
  await expect(terminalProblem).toHaveCount(0);
  await page.goto(`/companies/${companyId}/source-files/${postSplit.sourceFileId}`);
  const continuedDocuments = page.getByRole("table", { name: "Documents", exact: true });
  await expect(continuedDocuments.getByText("Needs review", { exact: true })).toHaveCount(1);
  await expect.poll(() => browserSourceFileStatus(postSplit.sourceFileId)).toBe("split");
  await page.goto("/platform/administration");
  await waitForHealthyDashboard(page);

  await expect.poll(async () => browserRemediationAuditActions([companyId, terminal.jobId, manual.sourceFileId])).toEqual(
    expect.arrayContaining([
      "company.ai_configuration_assigned",
      "company.ai_processing_allowance_changed",
      "processing.job_retried",
      "source_file.manual_review_started",
    ]),
  );
});

test("live operational alerts retain long configuration controls within CS/EN workspaces", async ({ baseURL, context, page }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await english(context, baseURL);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const companyPrefix = "Accounting and operational recovery Company with a long registered business name";
  const { companyId, email } = await provisionCompanyAdministrator(page, run, companyPrefix);
  await uploadReceipt(page, companyId);
  const sourceFileId = await addBrowserMissingConfigurationIssueFixture(companyId);
  await enrollSuperAdmin(page, email);
  const unavailableLabel = `Unavailable worker configuration with a long descriptive accounting label ${run}`;
  const unavailableId = await createOwnedConfiguration(page, unavailableLabel, "openai");
  const fakeId = await createOwnedConfiguration(page, `Owned fake configuration with a long descriptive accounting label ${run}`, "fake");
  await page.goto("/platform/administration");
  const missing = page.locator(".operational-problem").filter({ hasText: `${companyPrefix} ${run}` });
  await missing.getByLabel("AI Configuration", { exact: true }).selectOption(unavailableId);
  await missing.getByRole("button", { name: "Assign", exact: true }).click();
  const problem = page.locator(".operational-problem").filter({
    has: page.getByRole("definition").filter({ hasText: unavailableLabel }),
  });
  await expect.poll(async () => {
    await page.reload();
    return problem.getByRole("heading", { name: "AI Configuration unusable", exact: true }).count();
  }, { timeout: 45_000 }).toBe(1);
  for (const locale of ["en", "cs"] as const) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL }]);
    await page.reload();
    await expect(problem.getByRole("heading", { level: 3 })).toHaveText(locale === "en" ? "AI Configuration unusable" : "AI konfiguraci nelze použít");
    await problem.locator("summary").click();
    for (const width of [360, 720, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(problem).toBeVisible();
      expect(await browserSourceFileStatus(sourceFileId)).toBe("waiting_for_platform");
      const box = await problem.boundingBox();
      if (!box) throw new Error("Live operational alert missing");
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
      for (const control of await problem.locator('select, input:not([type="hidden"]), button').all()) {
        await expect(control).toBeVisible();
        const bounds = await control.boundingBox();
        if (!bounds) throw new Error("Live remediation control missing");
        expect(bounds.x).toBeGreaterThanOrEqual(box.x);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(Math.min(width, box.x + box.width));
      }
      if (width === 720 || width === 1440) await page.screenshot({ path: `test-results/live-alert-${locale}-${width}.png`, fullPage: true });
    }
  }
  const locale = await page.locator("html").getAttribute("lang");
  const row = problem.locator(".operational-remediation-company").filter({ hasText: `${companyPrefix} ${run}` });
  await row.getByLabel(locale === "cs" ? "AI konfigurace" : "AI Configuration", { exact: true }).selectOption(fakeId);
  await row.getByRole("button", { name: locale === "cs" ? "Přiřadit" : "Assign", exact: true }).click();
  await expect.poll(() => browserSourceFileStatus(sourceFileId), { timeout: 45_000 }).toBe("split");
  await page.reload();
  await expect(problem).toHaveCount(0);
});

test("SuperAdmin closes a failed Company export attempt and sees a later independent failure in CS/EN", async ({ baseURL, context, page }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { companyId, email } = await provisionCompanyAdministrator(page, run);
  await enrollSuperAdmin(page, email);
  const first = await addBrowserFailedExportAttemptFixture(companyId);
  const before = await browserExportAttemptState(first.exportId, first.jobId);
  await page.goto("/platform/administration");
  const problem = page.locator(".operational-problem").filter({ hasText: first.exportId });
  await expect(problem).toBeVisible();
  await expect(page.getByRole("link", { name: "Platform alerts, 1 unresolved" })).toBeVisible();
  await expect(page.locator("#failed-jobs").getByRole("row").filter({ hasText: first.exportId }).getByRole("button", { name: "Close failed export attempt", exact: true })).toBeVisible();
  await problem.getByRole("button", { name: "Close failed export attempt", exact: true }).click();
  await expect.poll(() => browserExportAttemptState(first.exportId, first.jobId)).toEqual({ ...before, closed_retry_count: 0 });
  await waitForHealthyDashboard(page);
  await expect(page.locator("#failed-jobs").getByRole("row").filter({ hasText: first.exportId })).toHaveCount(0);

  const later = await addBrowserFailedExportAttemptFixture(companyId);
  await page.reload();
  await expect(page.getByRole("link", { name: "Platform alerts, 1 unresolved" })).toBeVisible();
  await expect(page.locator("#failed-jobs").getByRole("row").filter({ hasText: later.exportId })).toHaveCount(1);
  await expect(page.locator("#failed-jobs").getByRole("row").filter({ hasText: first.exportId })).toHaveCount(0);
  await context.addCookies([{ name: "NEXT_LOCALE", value: "cs", url: baseURL }]);
  await page.reload();
  const row = page.locator("#failed-jobs").getByRole("row").filter({ hasText: later.exportId });
  await row.getByRole("button", { name: "Uzavřít neúspěšný pokus exportu", exact: true }).click();
  await expect.poll(async () => (await browserExportAttemptState(later.exportId, later.jobId)).closed_retry_count).toBe(0);
  await expect.poll(() => browserRemediationAuditActions([first.exportId, later.exportId])).toEqual([
    "company.export_attempt_closed", "company.export_attempt_closed",
  ]);
  expect(await browserExportAttemptState(first.exportId, first.jobId)).toEqual({ ...before, closed_retry_count: 0 });
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  await page.reload();
  await waitForHealthyDashboard(page);
});
