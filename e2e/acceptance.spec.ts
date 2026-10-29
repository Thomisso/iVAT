import fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { validateEpoXml } from "../src/application/epo-xml";
import {
  addBrowserCompanyMemberFixture,
  addBrowserDocumentWarningFixture,
  assignBrowserAiConfigurationFixture,
} from "../tests/support/e2e";

test("an administrator can turn an uploaded Source File into a traceable, exportable VAT Report", async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(240_000);
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100";
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const digits = Date.now().toString().slice(-8);
  const externalRequests: string[] = [];

  page.on("request", (request) => {
    const host = new URL(request.url()).hostname;
    if (host !== "127.0.0.1" && host !== "localhost")
      externalRequests.push(request.url());
  });
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: baseUrl },
  ]);

  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`E2E Organization ${run}`);
  await page.getByLabel("Email").fill(`admin-${run}@example.test`);
  await page.getByLabel("Password").fill("Playwright-password-1");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/companies\/new$/);

  const companyName = `E2E Company ${run}`;
  await page.getByLabel("Company name").fill(companyName);
  await page.getByLabel("IČO").fill(digits);
  await page.getByLabel("VAT ID").fill(`CZ${digits}`);
  await page.getByLabel("Street name").fill("Na Příkopě");
  await page.getByLabel("House number").fill("1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/setup\/filing-frequency$/);
  await page.getByLabel("Effective from").fill("01.01.2026");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/setup\/ai-processing$/, { timeout: 45_000 });
  const companyUrl = page.url().replace(/\/setup\/ai-processing$/, "");
  const companyId = new URL(companyUrl).pathname.split("/")[2];
  await assignBrowserAiConfigurationFixture(companyId);
  await page.goto(companyUrl);

  await page.goto(`${companyUrl}/members`);
  await page.getByLabel("Email").fill(`user-${run}@example.test`);
  await page.getByLabel("Role").selectOption("user");
  await page.getByRole("button", { name: "Invite user" }).click();
  await expect(page.getByRole("button", { name: "Invite user" })).toBeEnabled({
    timeout: 15_000,
  });
  await expect(page.getByLabel("Email")).toHaveValue("");

  await page.goto(`${companyUrl}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/two-invoices.pdf");
  const uploadFinished = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/finish") &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Upload" }).click();
  await uploadFinished;
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/upload-batches\/[0-9a-f-]+$/);
  const reviewBatch = page.getByRole("link", { name: "Review 2 Documents" });
  await expect(reviewBatch).toBeVisible({ timeout: 45_000 });
  await page.reload();
  await expect(reviewBatch).toBeVisible();
  const reviewBatchUrl = await reviewBatch.getAttribute("href");
  if (!reviewBatchUrl) throw new Error("Review Batch URL is missing");

  await page.goto(`${companyUrl}/vat-reports?period=2026-10`);
  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.getByText("Current data is not ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finalize and lock period" })).toBeDisabled();
  const blockers = page.getByRole("link", { name: "2 blocker Documents" });
  await expect(blockers).toBeVisible();
  await blockers.click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/documents\\?view=all&reportingPeriod=2026-10&readiness=blockers$`));
  await expect(page.getByRole("status").filter({ hasText: "2 Documents blocking 2026-10" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Documents" }).getByRole("link")).toHaveCount(2);

  await page.goto(reviewBatchUrl);
  await expect(page).toHaveURL(/\/documents\?view=review&batchId=[0-9a-f-]+$/);
  const documents = page.getByRole("table", { name: "Documents" });
  await expect(documents.getByRole("link")).toHaveCount(2);
  await documents.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+\?view=review&batchId=[0-9a-f-]+$/);
  const documentUrl = page.url();

  const documentNumber = `FV-E2E-${digits}`;
  await page.getByLabel("Document number", { exact: true }).fill(documentNumber);
  await page.getByLabel("Direction", { exact: true }).selectOption("incoming");
  await page.getByRole("button", { name: "Save corrections" }).click();
  await expect(page.getByRole("button", { name: "Approve version 2" })).toBeEnabled();
  const documentId = new URL(documentUrl).pathname.split("/").at(-1);
  if (!documentId) throw new Error("Document id is missing");
  await addBrowserDocumentWarningFixture(documentId);
  await page.reload();
  const approve = page.getByRole("button", { name: "Approve version 3" });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+\?view=review&batchId=[0-9a-f-]+$/);
  await expect(page.getByRole("button", { name: "Approve version 1" })).toBeVisible();
  const secondDocumentUrl = page.url();
  const rejectFinished = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url() === secondDocumentUrl && response.ok()
  );
  await page.getByRole("button", { name: "Reject" }).click();
  await rejectFinished;
  await page.goto(reviewBatchUrl);
  await expect(page.getByText("No documents match the filters.")).toBeVisible();

  await page.goto(`${companyUrl}/vat-reports?period=2026-10`);
  await expect(page.getByText("Stale", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Finalize and lock period" })).toBeDisabled();
  await page.getByRole("button", { name: "Generate / regenerate draft" }).click();
  await expect(page.getByText("This snapshot matches the relevant live Documents.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Finalize and lock period" })).toBeDisabled();
  await page.getByRole("navigation", { name: "Reporting Period destinations" })
    .getByRole("link", { name: "VAT Return" }).click();
  await expect(page.getByRole("heading", { name: "VAT Return · 2026-10" })).toBeVisible();

  const vatReturn = page.getByRole("table", { name: "VAT Return" });
  await vatReturn.locator("summary").first().click();
  await expect(vatReturn.getByRole("link", { name: documentNumber })).toBeVisible();

  const exportSection = page.locator("article").filter({
    has: page.getByRole("heading", { name: "VAT Return (DPHDP3)" }),
  });
  await exportSection.getByLabel("Tax office").selectOption("451");
  await exportSection.getByLabel("First name").fill("Jana");
  await exportSection.getByLabel("Last name").fill("Nováková");
  await exportSection.getByLabel("Capacity").fill("jednatelka");
  await exportSection.getByLabel("Email").fill(`admin-${run}@example.test`);
  await expect(exportSection.getByText("Working XML only", { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await exportSection.getByRole("button", { name: "Download XML" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("DRAFT_DPHDP3_2026-10.xml");
  const path = await download.path();
  expect(path).not.toBeNull();
  const xml = await fs.readFile(path!, "utf8");
  expect(await validateEpoXml(xml, "dphdp3")).toBe(true);

  await page
    .getByRole("navigation", { name: "Reporting Period destinations" })
    .getByRole("link", { name: "Export history" })
    .click();
  const artifacts = page.getByRole("table", { name: "Stored XML artifacts" });
  const storedDraft = artifacts.getByRole("link", { name: "DRAFT_DPHDP3_2026-10.xml" });
  await expect(storedDraft).toBeVisible();
  const storedDownloadPromise = page.waitForEvent("download");
  await storedDraft.click();
  const storedDownload = await storedDownloadPromise;
  expect(storedDownload.suggestedFilename()).toBe("DRAFT_DPHDP3_2026-10.xml");
  const storedPath = await storedDownload.path();
  expect(storedPath).not.toBeNull();
  expect(await fs.readFile(storedPath!, "utf8")).toBe(xml);

  await page.goto(`${companyUrl}/vat-reports?period=2026-10`);
  await expect(page.getByText("Confirm Finalization", { exact: true })).toBeVisible();
  const confirmationSummary = page.locator(".finalization-summary");
  await expect(confirmationSummary.getByText("Warnings").locator("..")).toContainText("1");
  await expect(confirmationSummary.getByText("Rejected Documents").locator("..")).toContainText("1");
  await page.getByRole("link", { name: "1 Document with warnings" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 Document with warnings for 2026-10" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Documents" }).getByRole("link")).toHaveCount(1);
  await page.goto(`${companyUrl}/vat-reports?period=2026-10`);
  await page.getByRole("link", { name: "Open 1 rejected Document" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 rejected Document for 2026-10" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Filters" })
    .getByRole("combobox", { name: "Status" })).toHaveValue("rejected");
  await expect(page.getByRole("table", { name: "Documents" }).getByRole("link")).toHaveCount(1);
  await page.goto(`${companyUrl}/vat-reports?period=2026-10`);
  await page.getByRole("checkbox", {
    name: "I understand that Finalization creates a Period Lock for this snapshot.",
  }).check();
  await expect(page.getByRole("button", { name: "Finalize and lock period" })).toBeEnabled();
  await page.getByRole("button", { name: "Finalize and lock period" }).click();
  await expect(page.getByRole("button", { name: "Unlock period" })).toBeVisible();
  await expect(page.getByText("Period locked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate / regenerate draft" })).toBeDisabled();

  await page
    .getByRole("navigation", { name: "Reporting Period destinations" })
    .getByRole("link", { name: "VAT Return" })
    .click();
  const finalExport = page.locator("article").filter({
    has: page.getByRole("heading", { name: "VAT Return (DPHDP3)" }),
  });
  await expect(finalExport.getByText("Final XML artifact", { exact: true })).toBeVisible();
  await finalExport.getByLabel("Tax office").selectOption("451");
  await finalExport.getByLabel("First name").fill("Jana");
  await finalExport.getByLabel("Last name").fill("Nováková");
  await finalExport.getByLabel("Capacity").fill("jednatelka");
  await finalExport.getByLabel("Email").fill(`final-${run}@example.test`);
  const finalDownloadPromise = page.waitForEvent("download");
  await finalExport.getByRole("button", { name: "Download XML" }).click();
  const finalDownload = await finalDownloadPromise;
  expect(finalDownload.suggestedFilename()).toBe("DPHDP3_2026-10.xml");
  const finalPath = await finalDownload.path();
  expect(finalPath).not.toBeNull();
  expect(await validateEpoXml(await fs.readFile(finalPath!, "utf8"), "dphdp3")).toBe(true);
  await page
    .getByRole("navigation", { name: "Reporting Period destinations" })
    .getByRole("link", { name: "Export history" })
    .click();
  const artifactHistory = page.getByRole("table", { name: "Stored XML artifacts" });
  await expect(artifactHistory.getByText("Final", { exact: true })).toBeVisible();
  await expect(artifactHistory.getByText("Working", { exact: true })).toBeVisible();
  await expect(artifactHistory.getByText(`final-${run}@example.test`, { exact: true })).toBeVisible();

  const userContext = await browser.newContext();
  await userContext.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseUrl }]);
  const userPage = await userContext.newPage();
  const userEmail = `report-user-${run}@example.test`;
  await userPage.goto("/signup");
  await userPage.getByLabel("Organization name").fill(`Report User Organization ${run}`);
  await userPage.getByLabel("Email").fill(userEmail);
  await userPage.getByLabel("Password").fill("Playwright-password-1");
  await userPage.getByRole("button", { name: "Sign up" }).click();
  await expect(userPage).toHaveURL(/\/companies\/new$/);
  await addBrowserCompanyMemberFixture(companyUrl.split("/").at(-1)!, userEmail);
  await userPage.goto(`${companyUrl}/vat-reports?period=2026-10`);
  await expect(userPage.getByText("Period locked", { exact: true })).toBeVisible();
  await expect(userPage.getByRole("table", { name: "Finalization history" })
    .getByText("Finalized", { exact: true })).toHaveCount(1);
  await expect(userPage.getByRole("button", { name: "Finalize and lock period" })).toHaveCount(0);
  await expect(userPage.getByRole("button", { name: "Unlock period" })).toHaveCount(0);
  await userContext.close();

  await page.goto(documentUrl);
  await expect(page.getByText(/Reporting period 2026-10 is locked/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save corrections" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reject" })).toHaveCount(0);

  await page.goto(`${companyUrl}/vat-reports?period=2026-10`);

  await page.getByLabel("Unlock reason").fill("Correct the reviewed invoice");
  await page.getByRole("checkbox", {
    name: "I understand that changes may require a new VAT Report and export.",
  }).check();
  await page.getByRole("button", { name: "Unlock period" }).click();
  await expect(page.getByRole("button", { name: "Finalize and lock period" })).toBeVisible();
  const history = page.getByRole("table", { name: "Finalization history" });
  await expect(history.getByText("Finalized", { exact: true })).toHaveCount(1);
  await expect(history.getByText("Unlocked", { exact: true })).toHaveCount(1);
  await expect(history.getByText("Correct the reviewed invoice", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", {
    name: "I understand that Finalization creates a Period Lock for this snapshot.",
  }).check();
  await page.getByRole("button", { name: "Finalize and lock period" }).click();
  await expect(page.getByRole("button", { name: "Unlock period" })).toBeVisible();
  await expect(page.getByText("Period locked", { exact: true })).toBeVisible();

  await page.goto(`${companyUrl}/settings/data`);
  page.once("dialog", (dialog) => void dialog.accept());
  const companyExport = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export and delete Company" }).click();
  const archive = await companyExport;
  expect(archive.suggestedFilename()).toMatch(/^iVAT-company-.*\.zip$/);
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect(page.getByText(companyName, { exact: true })).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});
