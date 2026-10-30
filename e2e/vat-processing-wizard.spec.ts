import { expect, test, type Locator, type Page } from "@playwright/test";
import { addBrowserCompanyMemberFixture, assignBrowserAiConfigurationFixture } from "../tests/support/e2e";
import { readFile } from "node:fs/promises";

function wizardStep(page: Page, title: string): Locator {
  return page
    .getByRole("list", { name: "VAT processing steps" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 2, name: title, exact: true }) });
}

async function emptyCompanyForExport(page: Page, street = "Dlouhá") {
  const run = crypto.randomUUID();
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Inline export ${run}`);
  await page.getByLabel("Email").fill(`inline-${run}@example.test`);
  await page.getByLabel("Password").fill("Playwright-password-1");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Company name").fill("Inline export Company");
  await page.getByLabel("IČO").fill("12345678");
  await page.getByLabel("VAT ID").fill("CZ12345678");
  await page.getByLabel("Street name").fill(street);
  await page.getByLabel("House number").fill("12");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/setup\/ai-processing$/);
  return page.url().replace(/\/setup\/ai-processing$/, "");
}

test("missing final filing details continue the selected export inline without changing Company defaults", async ({ context, page, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const companyUrl = await emptyCompanyForExport(page);
  const wizardUrl = `${companyUrl}/vat-reports?period=2026-01`;
  await page.goto(wizardUrl);
  await page.getByRole("button", { name: "Generate draft", exact: true }).click();
  const final = wizardStep(page, "Finalize");
  await final.getByRole("checkbox", { name: "I understand that Finalization creates a Period Lock for this snapshot." }).check();
  await final.getByRole("button", { name: "Finalize and lock period", exact: true }).click();
  await expect(final.getByText("Partially completed — 0/2", { exact: true })).toBeVisible();
  for (const [heading, label] of [["VAT Return (DPHDP3)", "Export VAT Return XML"], ["Control Statement (DPHKH1)", "Export Control Statement XML"]]) {
    const panel = final.getByRole("article").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
    await panel.getByRole("button", { name: label, exact: true }).click();
    await panel.getByRole("combobox", { name: "Tax office", exact: true }).selectOption("451");
    if (heading.startsWith("VAT Return")) await panel.getByLabel("Economic activity (CZ-NACE)").fill("621000");
    await panel.getByLabel("First name").fill("Jana");
    await panel.getByLabel("Last name").fill("Nováková");
    await panel.getByLabel("Capacity (e.g. director)").fill("director");
    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Download XML", exact: true }).click();
    const file = await (await download).path();
    if (!file) throw new Error("Final XML not downloaded");
    expect(await readFile(file, "utf8")).toContain("<Pisemnost");
    await expect(final.getByText(heading.startsWith("VAT Return") ? "Partially completed — 1/2" : "Done", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(wizardUrl);
  }
  await page.goto(`${companyUrl}/settings/vat`);
  await expect(page.getByLabel("Economic activity (CZ-NACE)")).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Tax office", exact: true })).toHaveValue("");
});

test("final progress follows successful downloads in the current lock cycle across retries and relocking", async ({ context, page, baseURL }) => {
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const companyUrl = await emptyCompanyForExport(page);
  await page.goto(`${companyUrl}/settings/vat`);
  await page.getByRole("combobox", { name: "Tax office", exact: true }).selectOption("451");
  await page.getByLabel("Economic activity (CZ-NACE)").fill("621000");
  await page.getByLabel("First name").fill("Jana");
  await page.getByLabel("Last name").fill("Nováková");
  await page.getByLabel("Capacity (e.g. director)").fill("director");
  await page.getByRole("button", { name: "Save filing defaults" }).click();
  await expect(page.getByRole("status").getByText("Filing defaults saved.")).toBeVisible();
  const wizardUrl = `${companyUrl}/vat-reports?period=2026-01`;
  const historyUrl = `${companyUrl}/vat-reports/2026-01/exports`;
  await page.goto(wizardUrl);
  await page.getByRole("button", { name: "Generate draft", exact: true }).click();
  const generate = wizardStep(page, "Generate VAT Report");
  const drafts = wizardStep(page, "Export DRAFT XML");
  const final = wizardStep(page, "Finalize");
  await expect(final.getByRole("button", { name: "Export VAT Return XML", exact: true })).toHaveCount(0);
  const draft = page.waitForEvent("download");
  await drafts.getByRole("button", { name: "Export VAT Return XML", exact: true }).click();
  await draft;
  await expect(drafts.getByText("Partially completed — 1/2", { exact: true })).toBeVisible();
  async function finalize() {
    await final.getByRole("checkbox", { name: "I understand that Finalization creates a Period Lock for this snapshot." }).check();
    await final.getByRole("button", { name: "Finalize and lock period", exact: true }).click();
    await expect(final.getByText("Partially completed — 0/2", { exact: true })).toBeVisible();
  }
  await finalize();
  for (const width of [360, 720]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(generate.getByRole("button", { name: "Generate / regenerate draft", exact: true })).toBeDisabled();
  await expect(drafts.getByRole("button", { name: "Export VAT Return XML", exact: true })).toBeDisabled();
  let failedArtifactId = "";
  let firstLockId = "";
  await page.route("**/vat-reports/2026-01/xml", async route => {
    const archived = await route.fetch();
    expect(archived.status()).toBe(200);
    failedArtifactId = archived.headers()["x-ivat-artifact-id"];
    firstLockId = archived.headers()["x-ivat-period-lock-id"];
    expect(firstLockId).toMatch(/^[0-9a-f-]{36}$/);
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "export_failed" }) });
  }, { times: 1 });
  await final.getByRole("button", { name: "Export VAT Return XML", exact: true }).click();
  await expect(final.getByText("Download failed. Try again.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(final.getByText("Partially completed — 0/2", { exact: true })).toBeVisible();
  await page.goto(historyUrl);
  const preserved = page.locator(`a[href$="/artifacts/${failedArtifactId}"]`);
  const retry = page.waitForEvent("download");
  await preserved.click();
  expect((await retry).suggestedFilename()).toBe("DPHDP3_2026-01.xml");
  await expect(preserved).not.toHaveAttribute("aria-disabled", "true");
  await page.goto(wizardUrl);
  await expect(final.getByText("Partially completed — 1/2", { exact: true })).toBeVisible();
  const repeated = page.waitForEvent("download");
  await final.getByRole("button", { name: "Export VAT Return XML", exact: true }).click();
  await repeated;
  await expect(final.getByText("Partially completed — 1/2", { exact: true })).toBeVisible();
  const second = page.waitForEvent("download");
  await final.getByRole("button", { name: "Export Control Statement XML", exact: true }).click();
  expect((await second).suggestedFilename()).toBe("DPHKH1_2026-01.xml");
  await expect(final.getByText("Done", { exact: true })).toBeVisible();
  await page.reload();
  await expect(final.getByText("Done", { exact: true })).toBeVisible();
  await final.getByLabel("Unlock reason", { exact: true }).fill("Check unchanged report again");
  await final.getByRole("checkbox", { name: "I understand that changes may require a new VAT Report and export." }).check();
  await final.getByRole("button", { name: "Unlock period", exact: true }).click();
  await expect(final.getByText("Not started", { exact: true })).toBeVisible();
  await expect(final.getByRole("button", { name: "Export VAT Return XML", exact: true })).toHaveCount(0);
  await finalize();
  await page.goto(historyUrl);
  const old = page.locator(`a[href$="/artifacts/${failedArtifactId}"]`);
  const oldDownload = page.waitForEvent("download");
  await old.click();
  await oldDownload;
  await expect(old).not.toHaveAttribute("aria-disabled", "true");
  await page.goto(wizardUrl);
  await expect(final.getByText("Partially completed — 0/2", { exact: true })).toBeVisible();
  let nextLockId = "";
  for (const format of ["VAT Return", "Control Statement"]) {
    const response = page.waitForResponse(r => r.url().endsWith("/2026-01/xml") && r.request().method() === "POST");
    const download = page.waitForEvent("download");
    await final.getByRole("button", { name: `Export ${format} XML`, exact: true }).click();
    await download;
    nextLockId = (await response).headers()["x-ivat-period-lock-id"];
    expect(nextLockId).toMatch(/^[0-9a-f-]{36}$/);
    expect(nextLockId).not.toBe(firstLockId);
    await expect(final.getByText(format === "VAT Return" ? "Partially completed — 1/2" : "Done", { exact: true })).toBeVisible();
  }
});

test("draft progress survives skips, shared users, regeneration and a lost XML response after archiving", async ({ context, page, browser, baseURL }) => {
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const companyUrl = await emptyCompanyForExport(page);
  const companyId = new URL(companyUrl).pathname.split("/")[2];
  await page.goto(`${companyUrl}/settings/vat`);
  await page.getByRole("combobox", { name: "Tax office", exact: true }).selectOption("451");
  await page.getByLabel("Economic activity (CZ-NACE)").fill("621000");
  await page.getByLabel("First name").fill("Jana");
  await page.getByLabel("Last name").fill("Nováková");
  await page.getByLabel("Capacity (e.g. director)").fill("director");
  await page.getByRole("button", { name: "Save filing defaults" }).click();
  await expect(page.getByRole("status").getByText("Filing defaults saved.")).toBeVisible();
  const wizardUrl = `${companyUrl}/vat-reports?period=2026-01`;
  const historyUrl = `${companyUrl}/vat-reports/2026-01/exports`;
  await page.goto(wizardUrl);
  await page.getByRole("button", { name: "Generate draft", exact: true }).click();
  const exports = wizardStep(page, "Export DRAFT XML");
  const generate = wizardStep(page, "Generate VAT Report");
  await expect(exports.getByText("Not started", { exact: true })).toBeVisible();
  await exports.getByRole("button", { name: "Skip draft exports", exact: true }).click();
  await expect(exports.getByText("Skipped", { exact: true })).toBeVisible();
  await page.reload();
  await expect(exports.getByText("Skipped", { exact: true })).toBeVisible();
  const response = page.waitForResponse(response => response.url().endsWith("/2026-01/xml") && response.request().method() === "POST");
  const first = page.waitForEvent("download");
  await exports.getByRole("button", { name: "Export VAT Return XML", exact: true }).click();
  await first;
  const oldArtifactId = (await response).headers()["x-ivat-artifact-id"];
  await expect(exports.getByText("Partially completed — 1/2, second export skipped", { exact: true })).toBeVisible();
  for (const width of [360, 720]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(exports.getByText("Partially completed — 1/2, second export skipped", { exact: true })).toBeVisible();
  const repeated = page.waitForEvent("download");
  await exports.getByRole("button", { name: "Export VAT Return XML", exact: true }).click();
  await repeated;
  await expect(exports.getByText("Partially completed — 1/2, second export skipped", { exact: true })).toBeVisible();
  const second = page.waitForEvent("download");
  await exports.getByRole("button", { name: "Export Control Statement XML", exact: true }).click();
  await second;
  await expect(exports.getByText("Done", { exact: true })).toBeVisible();
  await generate.getByRole("button", { name: "Generate / regenerate draft", exact: true }).click();
  await expect(exports.getByText("Not started", { exact: true })).toBeVisible();
  const newDraft = page.waitForEvent("download");
  await exports.getByRole("button", { name: "Export VAT Return XML", exact: true }).click();
  await newDraft;
  await expect(exports.getByText("Partially completed — 1/2", { exact: true })).toBeVisible();
  await exports.getByRole("button", { name: "Skip the remaining draft export", exact: true }).click();
  await expect(exports.getByText("Partially completed — 1/2, second export skipped", { exact: true })).toBeVisible();

  const peerContext = await browser.newContext({ baseURL });
  try {
    await peerContext.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
    const peer = await peerContext.newPage();
    const email = `shared-${crypto.randomUUID()}@example.test`;
    await peer.goto("/signup");
    await peer.getByLabel("Organization name").fill("Shared export User");
    await peer.getByLabel("Email").fill(email);
    await peer.getByLabel("Password").fill("Playwright-password-1");
    await peer.getByRole("button", { name: "Sign up" }).click();
    await expect(peer).toHaveURL(/\/companies\/new$/);
    await addBrowserCompanyMemberFixture(companyId, email);
    await peer.goto(wizardUrl);
    const peerExports = wizardStep(peer, "Export DRAFT XML");
    await expect(peerExports.getByText("Partially completed — 1/2, second export skipped", { exact: true })).toBeVisible();
    const peerDownload = peer.waitForEvent("download");
    await peerExports.getByRole("button", { name: "Export Control Statement XML", exact: true }).click();
    await peerDownload;
    await expect(peerExports.getByText("Done", { exact: true })).toBeVisible();
  } finally { await peerContext.close(); }
  await page.reload();
  await expect(exports.getByText("Done", { exact: true })).toBeVisible();

  await generate.getByRole("button", { name: "Generate / regenerate draft", exact: true }).click();
  await expect(exports.getByText("Not started", { exact: true })).toBeVisible();
  let failedArtifactId = "";
  await page.route("**/vat-reports/2026-01/xml", async route => {
    const archived = await route.fetch();
    expect(archived.status()).toBe(200);
    failedArtifactId = archived.headers()["x-ivat-artifact-id"];
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "export_failed" }) });
  }, { times: 1 });
  await exports.getByRole("button", { name: "Export VAT Return XML", exact: true }).click();
  await expect(exports.getByText("Download failed. Try again.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(exports.getByText("Not started", { exact: true })).toBeVisible();
  await page.goto(historyUrl);
  const current = page.locator(`a[href$="/artifacts/${failedArtifactId}"]`);
  await expect(current).toBeVisible();
  for (let attempt = 0; attempt < 2; attempt++) {
    const download = page.waitForEvent("download");
    await current.click();
    await download;
    await expect(current).not.toHaveAttribute("aria-disabled", "true");
  }
  const historical = page.locator(`a[href$="/artifacts/${oldArtifactId}"]`);
  const historicalDownload = page.waitForEvent("download");
  await historical.click();
  await historicalDownload;
  await expect(historical).not.toHaveAttribute("aria-disabled", "true");
  await page.goto(wizardUrl);
  await expect(exports.getByText("Partially completed — 1/2", { exact: true })).toBeVisible();
});

test("missing draft details are completed inline and failed downloads preserve entered values", async ({ context, page, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const companyUrl = await emptyCompanyForExport(page);
  const wizardUrl = `${companyUrl}/vat-reports?period=2026-01`;
  await page.goto(wizardUrl);
  await page.getByRole("button", { name: "Generate draft", exact: true }).click();
  const exports = wizardStep(page, "Export DRAFT XML");
  for (const [format, action] of [["VAT Return (DPHDP3)", "Export VAT Return XML"], ["Control Statement (DPHKH1)", "Export Control Statement XML"]]) {
    const panel = exports.getByRole("article").filter({ has: page.getByRole("heading", { name: format, exact: true }) });
    await panel.getByRole("button", { name: action, exact: true }).click();
    await expect(page).toHaveURL(wizardUrl);
    await panel.getByRole("combobox", { name: "Tax office", exact: true }).selectOption("451");
    if (format.startsWith("VAT Return")) await panel.getByLabel("Economic activity (CZ-NACE)").fill("621000");
    await panel.getByLabel("First name").fill("Jana");
    await panel.getByLabel("Last name").fill("Nováková");
    await panel.getByLabel("Capacity (e.g. director)").fill("director");
    await page.route("**/vat-reports/2026-01/xml", async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "export_failed" }) });
    }, { times: 1 });
    await panel.getByRole("button", { name: "Download XML" }).click();
    await expect(panel.getByText("Download failed. Try again.", { exact: true })).toBeVisible();
    await expect(panel.getByLabel("First name")).toHaveValue("Jana");
    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Download XML" }).click();
    expect((await download).suggestedFilename()).toMatch(/^DRAFT_DPH/);
  }
  await page.goto(`${companyUrl}/settings/vat`);
  await expect(page.getByLabel("Economic activity (CZ-NACE)")).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Tax office", exact: true })).toHaveValue("");
});

test("an Administrator confirms a missing EPO address inside the selected wizard export", async ({ context, page, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const companyUrl = await emptyCompanyForExport(page, "x".repeat(39));
  const wizardUrl = `${companyUrl}/vat-reports?period=2026-01`;
  await page.goto(wizardUrl);
  await page.getByRole("button", { name: "Generate draft", exact: true }).click();
  const panel = wizardStep(page, "Export DRAFT XML").getByRole("article").filter({ has: page.getByRole("heading", { name: "VAT Return (DPHDP3)", exact: true }) });
  await panel.getByRole("button", { name: "Export VAT Return XML", exact: true }).click();
  await panel.getByRole("combobox", { name: "Tax office", exact: true }).selectOption("451");
  await panel.getByLabel("Economic activity (CZ-NACE)").fill("621000");
  await panel.getByLabel("First name").fill("Jana");
  await panel.getByLabel("Last name").fill("Nováková");
  await panel.getByLabel("Capacity (e.g. director)").fill("director");
  await panel.getByRole("checkbox", { name: "Use a separate EPO address" }).check();
  await panel.getByLabel("Street name").fill("Dlouhá ulice");
  await panel.getByLabel("House number").fill("12");
  await panel.getByLabel("City", { exact: true }).fill("Praha");
  await panel.getByLabel("Postal code").fill("110 00");
  await panel.getByRole("checkbox", { name: "I confirm this separate address is the intended EPO filing address." }).check();
  await panel.getByRole("button", { name: "Save filing defaults" }).click();
  await expect(panel.getByRole("button", { name: "Download XML" })).toBeEnabled();
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download XML" }).click();
  const path = await (await download).path();
  if (!path) throw new Error("Confirmed-address export did not download");
  expect(await readFile(path, "utf8")).toContain('ulice="Dlouhá ulice"');
  await expect(page).toHaveURL(wizardUrl);
});

test("wizard exports both draft outputs directly with saved defaults and permits an explicit one-export edit", async ({ context, page, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = crypto.randomUUID();
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Direct export ${run}`);
  await page.getByLabel("Email").fill(`direct-${run}@example.test`);
  await page.getByLabel("Password").fill("Playwright-password-1");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Company name").fill("Direct export Company");
  await page.getByLabel("IČO").fill("12345678");
  await page.getByLabel("VAT ID").fill("CZ12345678");
  await page.getByLabel("Street name").fill("Dlouhá");
  await page.getByLabel("House number").fill("12");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/setup\/ai-processing$/);
  const companyUrl = page.url().replace(/\/setup\/ai-processing$/, "");
  await page.goto(`${companyUrl}/settings/vat`);
  await page.getByRole("combobox", { name: "Tax office", exact: true }).selectOption("451");
  await page.getByLabel("Economic activity (CZ-NACE)").fill("621000");
  await page.getByLabel("First name").fill("Jana");
  await page.getByLabel("Last name").fill("Nováková");
  await page.getByLabel("Capacity (e.g. director)").fill("director");
  await page.getByRole("button", { name: "Save filing defaults" }).click();
  await expect(page.getByRole("status").getByText("Filing defaults saved.")).toBeVisible();
  const wizardUrl = `${companyUrl}/vat-reports?period=2026-01`;
  await page.goto(wizardUrl);
  await page.getByRole("button", { name: "Generate draft", exact: true }).click();
  const exports = wizardStep(page, "Export DRAFT XML");
  await expect(exports.getByRole("button", { name: "Export VAT Return XML", exact: true })).toBeVisible();
  await expect(exports.getByLabel("Preparation date")).toHaveCount(0);
  for (const [label, fileName] of [["Export VAT Return XML", "DRAFT_DPHDP3_2026-01.xml"], ["Export Control Statement XML", "DRAFT_DPHKH1_2026-01.xml"]]) {
    const download = page.waitForEvent("download");
    await exports.getByRole("button", { name: label, exact: true }).click();
    expect((await download).suggestedFilename()).toBe(fileName);
    await expect(page).toHaveURL(wizardUrl);
  }
  const vatReturn = exports.getByRole("article").filter({ has: page.getByRole("heading", { name: "VAT Return (DPHDP3)", exact: true }) });
  await vatReturn.getByRole("button", { name: "Edit for this export" }).click();
  await expect(vatReturn.getByLabel("Economic activity (CZ-NACE)")).toHaveValue("621000");
  await vatReturn.getByLabel("Economic activity (CZ-NACE)").fill("622000");
  const override = page.waitForEvent("download");
  await vatReturn.getByRole("button", { name: "Download XML" }).click();
  const path = await (await override).path();
  if (!path) throw new Error("Draft override did not download");
  expect(await readFile(path, "utf8")).toContain('c_okec="622000"');
  await page.goto(`${companyUrl}/settings/vat`);
  await expect(page.getByLabel("Economic activity (CZ-NACE)")).toHaveValue("621000");
  await page.goto(wizardUrl);
  const finalization = wizardStep(page, "Finalize");
  await finalization.getByRole("checkbox", { name: "I understand that Finalization creates a Period Lock for this snapshot." }).check();
  await finalization.getByRole("button", { name: "Finalize and lock period" }).click();
  await expect(finalization.getByRole("button", { name: "Unlock period" })).toBeVisible();
  const staleDraft = await page.request.post(`${companyUrl}/vat-reports/2026-01/xml`, { form: { format: "dphdp3", kind: "draft" } });
  expect(staleDraft.status()).toBe(422);
  expect((await staleDraft.json()).error).toBe("report_finalized");
  await expect(exports.getByRole("button", { name: "Export VAT Return XML", exact: true })).toBeDisabled();
});

test("combined VAT processing journey recovers uploads, reviews warnings and completes both final lock cycles", async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100";
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseUrl }]);

  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`Wizard Organization ${run}`);
  await page.getByLabel("Email").fill(`wizard-${run}@example.test`);
  await page.getByLabel("Password").fill("Playwright-password-1");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/companies\/new$/);
  // The fake AI sample's customer, so its Documents are detected as incoming.
  await page.getByLabel("Company name").fill(`Wizard Company ${run}`);
  await page.getByLabel("IČO").fill("25596641");
  await page.getByLabel("VAT ID").fill("CZ25596641");
  await page.getByLabel("Street name").fill("Vinohradská");
  await page.getByLabel("House number").fill("12");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("12000");
  await page.getByRole("button", { name: "Create company" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/setup\/ai-processing$/, { timeout: 45_000 });
  const companyUrl = page.url().replace(/\/setup\/ai-processing$/, "");
  await assignBrowserAiConfigurationFixture(new URL(companyUrl).pathname.split("/")[2]);

  await page.goto(`${companyUrl}/settings/vat`);
  await page.getByRole("combobox", { name: "Tax office", exact: true }).selectOption("451");
  await page.getByLabel("Economic activity (CZ-NACE)").fill("621000");
  await page.getByLabel("First name").fill("Jana");
  await page.getByLabel("Last name").fill("Nováková");
  await page.getByLabel("Capacity (e.g. director)").fill("director");
  await page.getByRole("button", { name: "Save filing defaults", exact: true }).click();
  await expect(page.getByRole("status").getByText("Filing defaults saved.")).toBeVisible();

  await page.goto(`${companyUrl}/upload`);
  const picker = page.locator('input[type="file"]:not([capture])');
  await picker.setInputFiles("tests/fixtures/receipt.png");
  await picker.setInputFiles("tests/fixtures/two-invoices.pdf");
  const queue = page.locator(".upload-items");
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  const transfers: { name: string; sourceFileId: string; batchId: string }[] = [];
  const starts: { batchId: string; fileCount: number; selectedFiles: { id: string; sha256: string }[] }[] = [];
  await page.route(`${companyUrl}/upload-batches`, async route => {
    starts.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.route(`${companyUrl}/source-files`, async route => {
    const bytes = route.request().postDataBuffer();
    if (!bytes) throw new Error("Source File request has no multipart body");
    const form = await new Response(Uint8Array.from(bytes), {
      headers: { "Content-Type": route.request().headers()["content-type"] },
    }).formData();
    const file = form.get("file");
    if (!file || typeof file === "string") throw new Error("Source File request has no file");
    transfers.push({ name: file.name, sourceFileId: String(form.get("sourceFileId")), batchId: String(form.get("batchId")) });
    // Exhaust the browser's two automatic attempts so an explicit retry is required.
    if (file.name === "two-invoices.pdf" && transfers.filter(t => t.name === file.name).length <= 2) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "upload_failed" }) });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Upload batch", exact: true }).click();
  await expect(queue.getByRole("listitem").filter({ hasText: "receipt.png" })).toContainText("Uploaded");
  const failedFile = queue.getByRole("listitem").filter({ hasText: "two-invoices.pdf" });
  await expect(failedFile).toContainText("Not uploaded");
  await expect(failedFile.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry unsuccessful files", exact: true })).toBeEnabled();
  await page.reload();
  await expect(picker).toBeDisabled();
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Retry unsuccessful files", exact: true }).click();
  await expect(page).toHaveURL(/\/upload-batches\/[0-9a-f-]+$/);
  const batchId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByRole("link", { name: "Review 3 Documents", exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("link", { name: "receipt.png", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "two-invoices.pdf", exact: true })).toBeVisible();
  expect(starts).toHaveLength(2);
  expect(starts[0]).toMatchObject({ batchId, fileCount: 2 });
  expect(starts[1]).toEqual(starts[0]);
  expect(transfers.filter(t => t.name === "receipt.png")).toHaveLength(1);
  const pdfTransfers = transfers.filter(t => t.name === "two-invoices.pdf");
  expect(pdfTransfers).toHaveLength(3);
  expect(new Set(pdfTransfers.map(t => t.sourceFileId)).size).toBe(1);
  expect(new Set(transfers.map(t => t.batchId))).toEqual(new Set([batchId]));
  expect(new Set(transfers.map(t => t.sourceFileId))).toEqual(new Set(starts[0].selectedFiles.map(f => f.id)));
  await page.unroute(`${companyUrl}/upload-batches`);
  await page.unroute(`${companyUrl}/source-files`);

  const wizardUrl = `${companyUrl}/vat-reports?period=2026-10`;
  await page.goto(wizardUrl);
  await expect(page.getByRole("combobox", { name: "Reporting Period" })).toHaveValue("2026-10");
  await expect(page.getByRole("list", { name: "VAT processing steps" }).getByRole("heading", { level: 2 }))
    .toHaveText([
      "Documents to review",
      "Generate VAT Report",
      "Review VAT Return and Control Statement",
      "Export DRAFT XML",
      "Finalize",
    ]);
  const review = wizardStep(page, "Documents to review");
  const generate = wizardStep(page, "Generate VAT Report");
  const finalize = wizardStep(page, "Finalize");
  await expect(review.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(generate.getByText("Blocked", { exact: true })).toBeVisible();
  await expect(generate.getByRole("note")).toHaveText(
    "Available once step 1 (Documents to review) is done. Documents in this Reporting Period still need review.",
  );
  await expect(generate.getByRole("button", { name: "Generate draft" })).toBeDisabled();
  await expect(finalize.getByRole("button", { name: "Finalize and lock period" })).toHaveCount(0);

  const documentLinks = review.getByRole("listitem").getByRole("link");
  await expect(documentLinks).toHaveCount(3);
  for (let remaining = 3; remaining > 0; remaining--) {
    await documentLinks.first().click();
    await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+\?/);
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(`${new URL(wizardUrl).pathname}?period=2026-10#vat-step-review`);
    if (remaining === 3) {
      await page.getByRole("link", { name: "← Back to Processing", exact: true }).click();
      await expect(page).toHaveURL(`${wizardUrl}#vat-step-review`);
      await documentLinks.first().click();
    }
    if (remaining === 3) {
      await page.getByLabel("Bank account", { exact: true }).fill("999999/0100");
      await page.getByRole("button", { name: "Save corrections", exact: true }).click();
      await expect(page.getByText("The payment account is not published for this supplier in the VAT payer registry.", { exact: true })).toBeVisible();
    }
    const approve = page.getByRole("button", { name: remaining === 3 ? "Approve version 2" : "Approve version 1", exact: true });
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(approve).toHaveCount(0);
    await expect(page).toHaveURL(`${wizardUrl}#vat-step-review`);
    await expect(documentLinks).toHaveCount(remaining - 1);
  }

  await expect(review.getByText("Done", { exact: true })).toBeVisible();
  await expect(generate.getByText("Not started", { exact: true })).toBeVisible();
  await generate.getByRole("button", { name: "Generate draft" }).click();
  await expect(generate.getByText("Done", { exact: true })).toBeVisible();

  const outputs = wizardStep(page, "Review VAT Return and Control Statement");
  await outputs.getByRole("link", { name: "Open VAT Return" }).click();
  await expect(page.getByRole("heading", { name: "VAT Return · 2026-10" })).toBeVisible();
  const outputUrl = page.url();
  await page.getByRole("table", { name: "VAT Return", exact: true }).locator("details").first().locator("summary").click();
  const contribution = page.getByRole("list", { name: "Contributing Documents" }).first().getByRole("link").first();
  await contribution.click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+\?/);
  const outputOrigin = new URL(page.url()).searchParams.get("returnTo");
  expect(outputOrigin).toContain("/vat-reports/2026-10/vat-return?");
  expect(outputOrigin).toMatch(/#vat-line-\d+$/);
  await page.getByRole("link", { name: "← Back to VAT Return", exact: true }).click();
  await expect(page).toHaveURL(/\/vat-return\?.*#vat-line-\d+$/);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(`${new URL(wizardUrl).pathname}?period=2026-10#vat-step-outputs`);
  await page.getByRole("link", { name: "← Back to Processing", exact: true }).click();
  await expect(page).toHaveURL(`${wizardUrl}#vat-step-outputs`);
  await wizardStep(page, "Export DRAFT XML").getByRole("link", { name: "Open Export history" }).click();
  await expect(page).toHaveURL(/\/vat-reports\/2026-10\/exports\?/);
  await page.getByRole("link", { name: "← Back to Processing", exact: true }).click();
  await expect(page).toHaveURL(`${wizardUrl}#vat-step-export`);
  await page.goto(new URL(outputUrl).pathname);
  await expect(page.getByRole("link", { name: "← Back to Reporting Periods", exact: true })).toHaveAttribute("href", `${new URL(companyUrl).pathname}/vat`);

  await page.goto(wizardUrl);
  const drafts = wizardStep(page, "Export DRAFT XML");
  await expect(drafts.getByLabel("Preparation date")).toHaveCount(0);
  const draftDownload = page.waitForEvent("download");
  await drafts.getByRole("button", { name: "Export VAT Return XML", exact: true }).click();
  const draft = await draftDownload;
  expect(draft.suggestedFilename()).toBe("DRAFT_DPHDP3_2026-10.xml");
  const draftPath = await draft.path();
  if (!draftPath) throw new Error("Draft XML not downloaded");
  expect(await readFile(draftPath, "utf8")).toContain("<Pisemnost");
  await expect(drafts.getByText("Partially completed — 1/2", { exact: true })).toBeVisible();
  await drafts.getByRole("button", { name: "Skip the remaining draft export", exact: true }).click();
  await expect(drafts.getByText("Partially completed — 1/2, second export skipped", { exact: true })).toBeVisible();
  await page.reload();
  await expect(drafts.getByText("Partially completed — 1/2, second export skipped", { exact: true })).toBeVisible();
  await expect(finalize.getByText("Not started", { exact: true })).toBeVisible();
  await finalize.getByRole("checkbox", {
    name: "I understand that Finalization creates a Period Lock for this snapshot.",
  }).check();
  await finalize.getByRole("button", { name: "Finalize and lock period" }).click();
  await expect(finalize.getByRole("button", { name: "Unlock period" })).toBeVisible();
  await expect(finalize.getByText("Partially completed — 0/2", { exact: true })).toBeVisible();
  await expect(generate.getByRole("button", { name: "Generate / regenerate draft" })).toBeDisabled();
  await expect(drafts.getByRole("button", { name: "Export VAT Return XML", exact: true })).toBeDisabled();
  const cycles: { lockId: string; generation: string }[] = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const [format, fileName, progress] of [
      ["VAT Return", "DPHDP3_2026-10.xml", "Partially completed — 1/2"],
      ["Control Statement", "DPHKH1_2026-10.xml", "Done"],
    ]) {
      const response = page.waitForResponse(r => r.url().endsWith("/2026-10/xml") && r.request().method() === "POST");
      const download = page.waitForEvent("download");
      await finalize.getByRole("button", { name: `Export ${format} XML`, exact: true }).click();
      const received = await response;
      expect(received.status()).toBe(200);
      const identity = { lockId: received.headers()["x-ivat-period-lock-id"], generation: received.headers()["x-ivat-report-generated-at"] };
      expect(identity.lockId).toMatch(/^[0-9a-f-]{36}$/);
      if (format === "VAT Return") cycles.push(identity);
      else expect(identity).toEqual(cycles[cycle]);
      const file = await download;
      expect(file.suggestedFilename()).toBe(fileName);
      const path = await file.path();
      if (!path) throw new Error("Final XML not downloaded");
      expect(await readFile(path, "utf8")).toContain("<Pisemnost");
      await expect(finalize.getByText(progress, { exact: true })).toBeVisible();
    }
    await page.reload();
    await expect(finalize.getByText("Done", { exact: true })).toBeVisible();
    if (cycle === 0) {
      await finalize.getByLabel("Unlock reason", { exact: true }).fill("Review the unchanged report again");
      await finalize.getByRole("checkbox", { name: "I understand that changes may require a new VAT Report and export.", exact: true }).check();
      await finalize.getByRole("button", { name: "Unlock period", exact: true }).click();
      await expect(finalize.getByText("Not started", { exact: true })).toBeVisible();
      await expect(finalize.getByRole("button", { name: "Export VAT Return XML", exact: true })).toHaveCount(0);
      await finalize.getByRole("checkbox", { name: "I understand that Finalization creates a Period Lock for this snapshot.", exact: true }).check();
      await finalize.getByRole("button", { name: "Finalize and lock period", exact: true }).click();
      await expect(finalize.getByText("Partially completed — 0/2", { exact: true })).toBeVisible();
    }
  }
  expect(cycles[1].lockId).not.toBe(cycles[0].lockId);
  expect(cycles[1].generation).toBe(cycles[0].generation);
  await drafts.getByRole("link", { name: "Open Export history", exact: true }).click();
  await page.getByRole("link", { name: "← Back to Processing", exact: true }).click();
  await expect(page).toHaveURL(`${wizardUrl}#vat-step-export`);
  await expect(finalize.getByText("Done", { exact: true })).toBeVisible();
});
