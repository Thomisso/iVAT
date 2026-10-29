import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { validateEpoXml } from "../src/application/epo-xml";
import type { Database } from "../src/lib/database.types";

async function serviceClient() {
  const contents = await fs.readFile(".env.local", "utf8");
  const environment = Object.fromEntries(contents.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  return createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

test("an administrator can turn an uploaded Source File into a traceable, exportable VAT Report", async ({
  browser,
  context,
  page,
}) => {
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
  await page.getByLabel("Effective from").fill("2026-01-01");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/setup\/ai-processing$/);
  const companyUrl = page.url().replace(/\/setup\/ai-processing$/, "");
  await page.getByRole("radio").first().check();
  await page.getByRole("checkbox", { name: /I consent to sending this Company's documents/ }).check();
  await page.getByRole("button", { name: "Enable AI processing" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+$/);
  const aiSetup = page.getByRole("listitem").filter({
    has: page.getByText("AI processing", { exact: true }),
  });
  await expect(aiSetup.getByText("Completed", { exact: true })).toBeVisible();

  await page.goto(`${companyUrl}/members`);
  await page.getByLabel("Email").fill(`user-${run}@example.test`);
  await page.getByLabel("Role").selectOption("user");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("button", { name: "Send invitation" })).toBeEnabled({
    timeout: 15_000,
  });
  await expect(page.getByLabel("Email")).toHaveValue("");

  await page.goto(`${companyUrl}/upload`);
  await page.locator('input[type="file"]').setInputFiles("tests/fixtures/two-invoices.pdf");
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
  const approve = page.getByRole("button", { name: "Approve version 2" });
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
  await expect(page.getByRole("button", { name: "Finalize and lock period" })).toBeEnabled();
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
  const downloadPromise = page.waitForEvent("download");
  await exportSection.getByRole("button", { name: "Download XML" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const xml = await fs.readFile(path!, "utf8");
  expect(await validateEpoXml(xml, "dphdp3")).toBe(true);

  await page.goto(`${companyUrl}/vat-reports?period=2026-10`);
  await expect(page.getByText("Confirm Finalization", { exact: true })).toBeVisible();
  const confirmationSummary = page.locator(".finalization-summary");
  await expect(confirmationSummary.getByText("Warnings").locator("..")).toContainText("1");
  await expect(confirmationSummary.getByText("Rejected Documents").locator("..")).toContainText("1");
  await page.getByRole("checkbox", {
    name: "I understand that Finalization creates a Period Lock for this snapshot.",
  }).check();
  await page.getByRole("button", { name: "Finalize and lock period" }).click();
  await expect(page.getByRole("button", { name: "Unlock period" })).toBeVisible();
  await expect(page.getByText("Period locked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate / regenerate draft" })).toBeDisabled();

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
  const service = await serviceClient();
  const [{ data: company }, { data: users }] = await Promise.all([
    service.from("company").select("organization_id").eq("id", companyUrl.split("/").at(-1)!).single(),
    service.auth.admin.listUsers(),
  ]);
  const userId = users.users.find((user) => user.email === userEmail)?.id;
  if (!company || !userId) throw new Error("Could not prepare regular User browser fixture");
  const membership = await service.from("membership").insert({
    company_id: companyUrl.split("/").at(-1)!,
    email: userEmail,
    organization_id: company.organization_id,
    role: "user",
    user_id: userId,
  });
  if (membership.error) throw membership.error;
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

  await page.goto(`${companyUrl}/settings`);
  page.once("dialog", (dialog) => void dialog.accept());
  const companyExport = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export and delete Company" }).click();
  const archive = await companyExport;
  expect(archive.suggestedFilename()).toMatch(/^iVAT-company-.*\.zip$/);
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect(page.getByText(companyName, { exact: true })).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});
