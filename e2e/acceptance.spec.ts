import fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { validateEpoXml } from "../src/application/epo-xml";

test("an administrator can turn an uploaded Source File into a traceable, exportable VAT Report", async ({
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
  await page.getByLabel("Street and number").fill("Na Příkopě 1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByLabel("Effective from").fill("2026-01-01");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+$/);
  const companyUrl = page.url();

  await page.getByRole("button", { name: "Enable AI processing" }).click();
  await expect(page.getByText(/AI processing is on/)).toBeVisible();

  await page.getByRole("link", { name: "Members" }).click();
  await page.getByLabel("Email").fill(`user-${run}@example.test`);
  await page.getByLabel("Role").selectOption("user");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("button", { name: "Send invitation" })).toBeEnabled({
    timeout: 15_000,
  });
  await expect(page.getByLabel("Email")).toHaveValue("");

  await page.goto(companyUrl);
  await page.locator('input[type="file"]').setInputFiles("tests/fixtures/receipt.png");
  await page.getByRole("button", { name: "Upload" }).click();
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByText("Needs review").count();
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("table", { name: "Documents" })
    .getByRole("link")
    .first()
    .click();

  const documentNumber = `FV-E2E-${digits}`;
  await page.getByLabel("Document number", { exact: true }).fill(documentNumber);
  await page.getByLabel("Direction", { exact: true }).selectOption("incoming");
  await page.getByRole("button", { name: "Save corrections" }).click();
  const approve = page.getByRole("button", { name: "Approve version 2" });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByText("Approved. The document counts towards VAT reports.")).toBeVisible();

  await page.getByRole("link", { name: "VAT Reports" }).click();
  const generate = page.locator("form").filter({
    has: page.getByRole("button", { name: "Generate draft" }),
  });
  await generate.locator('input[name="period"]').fill("2026-10");
  await generate.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.getByRole("heading", { name: "Draft · 2026-10" })).toBeVisible();

  const vatReturn = page.getByRole("table", { name: "VAT Return" });
  await vatReturn.locator("summary").first().click();
  await expect(vatReturn.getByRole("link", { name: documentNumber })).toBeVisible();

  const exportSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Tax portal export" }),
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

  await page.getByRole("button", { name: "Finalize and lock period" }).click();
  await expect(page.getByRole("button", { name: "Unlock period" })).toBeVisible();
  await expect(page.getByText("Period locked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate / regenerate draft" })).toBeDisabled();

  await page.goto(`${companyUrl}/settings`);
  page.once("dialog", (dialog) => void dialog.accept());
  const companyExport = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export and delete Company" }).click();
  const archive = await companyExport;
  expect(archive.suggestedFilename()).toMatch(/^iVAT-company-.*\.zip$/);
  await expect(page).toHaveURL(/\/companies\/new$/, { timeout: 30_000 });
  await expect(page.getByText(companyName, { exact: true })).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});
