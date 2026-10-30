import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { failOneDocumentInUploadBatch } from "../tests/support/browser-upload";
import { assignBrowserAiConfigurationFixture } from "../tests/support/e2e";

const password = "Playwright-password-81";

async function english(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
}

async function createCompany(page: Page, run: string, existingOrganization = false): Promise<string> {
  if (existingOrganization) await page.goto("/companies/new");
  else {
    await page.goto("/signup");
    await page.getByLabel("Organization name").fill(`Upload Organization ${run}`);
    await page.getByLabel("Email").fill(`upload-${run}@example.test`);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign up" }).click();
  }
  await page.getByLabel("Company name").fill(`Upload Company ${run}`);
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
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/setup/ai-processing$`));
  await assignBrowserAiConfigurationFixture(companyId);
  await page.getByRole("link", { name: "Continue to Company" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));
  return companyId;
}

test("a batch survives reload, exposes partial recovery, then hands off its complete queue", async ({
  baseURL,
  context,
  page,
}) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const companyId = await createCompany(page, run);

  await page.goto(`/companies/${companyId}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/two-invoices.pdf");
  let batchStarts = 0;
  await page.route(`**/companies/${companyId}/upload-batches`, async (route) => {
    batchStarts += 1;
    if (batchStarts === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Upload batch", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry unsuccessful files", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Retry unsuccessful files", exact: true }).click();
  await expect(page).toHaveURL(/\/upload-batches\/[0-9a-f-]+$/);
  expect(batchStarts).toBe(2);
  const batchUrl = page.url();
  const batchId = new URL(batchUrl).pathname.split("/").at(-1)!;
  const reviewTwo = page.getByRole("link", { name: "Review 2 Documents" });
  await expect(reviewTwo).toBeVisible({ timeout: 45_000 });
  await page.reload();
  await expect(reviewTwo).toBeVisible();

  await failOneDocumentInUploadBatch(batchId);

  await page.reload();
  await expect(page.getByText("Finished with failures", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review 1 Document" })).toBeVisible();
  await page.getByRole("button", { name: "Retry Extraction" }).click();
  await expect(reviewTwo).toBeVisible({ timeout: 45_000 });
  await reviewTwo.click();
  await expect(page).toHaveURL((url) => url.pathname === `/companies/${companyId}/documents` && url.searchParams.size === 3 && url.searchParams.get("view") === "review" && url.searchParams.get("batchId") === batchId && url.searchParams.get("returnTo") === `/companies/${companyId}/upload-batches/${batchId}`);
  await expect(page.getByRole("table", { name: "Documents" }).getByRole("link")).toHaveCount(2);
});

test("the upload card and populated Batch history remain aligned and contained at every workspace width", async ({
  baseURL,
  context,
  page,
}, testInfo) => {
  await english(context, baseURL);
  await page.setViewportSize({ width: 1440, height: 900 });
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const companyId = await createCompany(page, run);
  await page.goto(`/companies/${companyId}/upload`);

  const card = page.getByRole("region", { name: "Add Source Files" });
  await expect(card.getByText("Drop a Source File here")).toBeVisible();
  await expect(card.getByLabel("Direction")).toHaveCount(0);
  await expect(card.getByText("Take document photo")).toBeHidden();

  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/two-invoices.pdf");
  await page.getByRole("button", { name: "Upload batch", exact: true }).click();
  await expect(page).toHaveURL(/\/upload-batches\/[0-9a-f-]+$/);
  const batchId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByRole("link", { name: "Review 2 Documents" })).toBeVisible({ timeout: 45_000 });

  for (const locale of ["en", "cs"]) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: new URL(baseURL!).origin }]);
    await page.goto(`/companies/${companyId}/upload`);
    const upload = page.getByRole("region", { name: locale === "en" ? "Add Source Files" : "Přidat zdrojové soubory" });
    const history = page.getByRole("region", { name: locale === "en" ? "Batch history" : "Historie dávek" });
    const row = history.getByRole("list").getByRole("link");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("href", new RegExp(`/upload-batches/${batchId}\\?`));
    await expect(row).toContainText(locale === "en" ? "2 ready for review" : "2 ke kontrole");
    const cells = row.locator(":scope > *");
    await expect(cells).toHaveCount(4);
    for (const width of [1440, 1024, 720, 360]) {
      await page.setViewportSize({ width, height: 900 });
      const [cardBox, historyBox, rowBox] = await Promise.all([upload.boundingBox(), history.boundingBox(), row.boundingBox()]);
      if (!cardBox || !historyBox || !rowBox) throw new Error("Upload workspace is not rendered");
      expect(cardBox.x).toBe(historyBox.x);
      expect(cardBox.width).toBe(historyBox.width);
      for (const cell of await cells.all()) {
        await expect(cell).toBeVisible();
        const bounds = await cell.boundingBox();
        if (!bounds) throw new Error("Batch history cell is not rendered");
        expect(bounds.x).toBeGreaterThanOrEqual(rowBox.x);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await row.focus();
      await expect(row).toBeFocused();
      await testInfo.attach(`populated-history-${locale}-${width}`, { body: await history.screenshot({ path: testInfo.outputPath(`populated-history-${locale}-${width}.png`) }), contentType: "image/png" });
    }
  }
});

test("a permanently refused file remains visible after reload and can finish as a failed batch before a new queue", async ({ baseURL, context, page }) => {
  await english(context, baseURL);
  const companyId = await createCompany(page, `refused-${Date.now()}`);
  await page.goto(`/companies/${companyId}/upload`);
  const picker = page.locator('input[type="file"]:not([capture])');
  await picker.setInputFiles([
    { name: "receipt.png", mimeType: "image/png", buffer: (await import("node:fs")).readFileSync("tests/fixtures/receipt.png") },
    { name: "corrupt.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nnot really a PDF") },
  ]);
  let successfulTransfers = 0;
  await page.route("**/source-files", async (route) => {
    if (route.request().postDataBuffer()?.includes(Buffer.from("receipt.png"))) successfulTransfers += 1;
    await route.continue();
  });
  await page.getByRole("button", { name: "Upload batch", exact: true }).click();
  const failedItem = page.locator(".upload-items li").filter({ hasText: "corrupt.pdf" });
  await expect(failedItem).toContainText("Not uploaded");
  await expect(failedItem.getByRole("alert")).toBeVisible();
  await page.reload();
  await expect(failedItem).toContainText("Not uploaded");
  await expect(picker).toBeDisabled();
  const finishFailed = page.getByRole("button", { name: "Finish batch with failed files", exact: true });
  await expect(finishFailed).toBeVisible({ timeout: 1_000 });
  await finishFailed.click();
  await expect(page).toHaveURL(/\/upload-batches\/[0-9a-f-]+$/);
  await expect(page.getByText("Finished with failures", { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("link", { name: "receipt.png", exact: true })).toBeVisible();
  await expect(page.getByText("1 selected file was not stored during transport.", { exact: false })).toBeVisible();
  await page.goto(`/companies/${companyId}/upload`);
  await expect(picker).toBeEnabled();
  await expect(page.locator(".upload-items li")).toHaveCount(0);
  await picker.setInputFiles("tests/fixtures/receipt.jpg");
  await expect(page.locator(".upload-items li")).toHaveCount(1);
  expect(successfulTransfers).toBe(1);
});

for (const committed of [false, true]) {
  test(`a lost finish response ${committed ? "after commit" : "before receipt"} reconciles after reload without retransferring successful files`, async ({ baseURL, context, page }) => {
    await english(context, baseURL);
    const companyId = await createCompany(page, `finish-${committed}-${Date.now()}`);
    await page.goto(`/companies/${companyId}/upload`);
    const picker = page.locator('input[type="file"]:not([capture])');
    await picker.setInputFiles("tests/fixtures/receipt.png");
    let sourceTransfers = 0;
    let finishAttempts = 0;
    const batchUrls: string[] = [];
    await page.route("**/source-files", async (route) => {
      sourceTransfers += 1;
      await route.continue();
    });
    await page.route("**/upload-batches/*/finish", async (route) => {
      finishAttempts += 1;
      batchUrls.push(route.request().url());
      if (finishAttempts === 1) {
        if (committed) await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await page.getByRole("button", { name: "Upload batch", exact: true }).click();
    await expect(page.locator(".upload-items li")).toContainText("Uploaded");
    await expect.poll(() => finishAttempts).toBe(1);
    await expect(page.getByRole("region", { name: "Add Source Files", exact: true }).getByRole("alert")).toBeVisible();
    await page.reload();
    const finish = page.getByRole("button", { name: "Finish batch", exact: true });
    await expect(finish).toBeEnabled({ timeout: 1_000 });
    await finish.click();
    await expect(page).toHaveURL(/\/upload-batches\/[0-9a-f-]+$/);
    await expect(page.getByRole("link", { name: "receipt.png", exact: true })).toBeVisible();
    expect(sourceTransfers).toBe(1);
    expect(finishAttempts).toBe(2);
    expect(batchUrls[1]).toBe(batchUrls[0]);
    await page.goto(`/companies/${companyId}/upload`);
    await expect(picker).toBeEnabled();
    await expect(page.locator(".upload-items li")).toHaveCount(0);
    await picker.setInputFiles("tests/fixtures/receipt.jpg");
    await expect(page.locator(".upload-items li")).toHaveCount(1);
  });
}

test("successive picks and drops accumulate, explain identical content and restore removable waiting files", async ({ baseURL, context, page }) => {
  await english(context, baseURL);
  const companyId = await createCompany(page, `queue-${Date.now()}`);
  await page.goto(`/companies/${companyId}/upload`);
  const picker = page.locator('input[type="file"]:not([capture])');
  await picker.setInputFiles("tests/fixtures/receipt.png");
  await picker.setInputFiles("tests/fixtures/two-invoices.pdf");
  const queue = page.locator(".upload-items");
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  await picker.setInputFiles({ name: "renamed.png", mimeType: "image/png", buffer: (await import("node:fs")).readFileSync("tests/fixtures/receipt.png") });
  await expect(page.getByRole("status").filter({ hasText: "Identical file" })).toBeVisible();
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  await page.locator(".iv-drop").dispatchEvent("drop", { dataTransfer: await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["different file contents"], "receipt.png", { type: "image/png" }));
    return transfer;
  }) });
  await expect(queue.getByRole("listitem")).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "Draft restored" })).toBeVisible();
  await expect(queue.getByRole("listitem")).toHaveCount(3);
  await page.getByRole("button", { name: "Remove two-invoices.pdf", exact: true }).click();
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Upload batch", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Batch history" })).not.toContainText("Processing");
  const otherCompanyId = await createCompany(page, `other-${Date.now()}`, true);
  await page.goto(`/companies/${otherCompanyId}/upload`);
  await expect(queue.getByRole("listitem")).toHaveCount(0);
  await picker.setInputFiles("tests/fixtures/receipt.jpg");
  await expect(queue.getByRole("listitem")).toHaveCount(1);
  await page.goto(`/companies/${companyId}/upload`);
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  await expect(queue).not.toContainText("receipt.jpg");
});
