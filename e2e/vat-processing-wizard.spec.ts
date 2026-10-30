import { expect, test, type Locator, type Page } from "@playwright/test";
import { assignBrowserAiConfigurationFixture } from "../tests/support/e2e";

function wizardStep(page: Page, title: string): Locator {
  return page
    .getByRole("list", { name: "VAT processing steps" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 2, name: title, exact: true }) });
}

test("an administrator walks the VAT processing wizard from review to Finalization", async ({
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

  await page.goto(`${companyUrl}/upload`);
  await page.locator('input[type="file"]:not([capture])').setInputFiles("tests/fixtures/two-invoices.pdf");
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("link", { name: "Review 2 Documents" })).toBeVisible({ timeout: 45_000 });

  const wizardUrl = `${companyUrl}/vat-reports?period=2026-10`;
  await page.goto(wizardUrl);
  await expect(page.getByRole("combobox", { name: "Reporting Period" })).toHaveValue("2026-10");
  await expect(page.getByRole("list", { name: "VAT processing steps" }).getByRole("heading", { level: 2 }))
    .toHaveText([
      "Documents to review",
      "Generate VAT Report",
      "Review VAT Return and Control Statement",
      "Export XML",
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
  await expect(documentLinks).toHaveCount(2);
  for (let remaining = 2; remaining > 0; remaining--) {
    await documentLinks.first().click();
    await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+$/);
    await page.getByRole("button", { name: "Approve version 1" }).click();
    await expect(page.getByRole("button", { name: "Approve version 1" })).toHaveCount(0);
    await page.goto(wizardUrl);
    await expect(documentLinks).toHaveCount(remaining - 1);
  }

  await expect(review.getByText("Done", { exact: true })).toBeVisible();
  await expect(generate.getByText("Not started", { exact: true })).toBeVisible();
  await generate.getByRole("button", { name: "Generate draft" }).click();
  await expect(generate.getByText("Done", { exact: true })).toBeVisible();

  const outputs = wizardStep(page, "Review VAT Return and Control Statement");
  await outputs.getByRole("link", { name: "Open VAT Return" }).click();
  await expect(page.getByRole("heading", { name: "VAT Return · 2026-10" })).toBeVisible();
  await page.goto(wizardUrl);
  await wizardStep(page, "Export XML").getByRole("link", { name: "Open Export history" }).click();
  await expect(page).toHaveURL(/\/vat-reports\/2026-10\/exports$/);

  await page.goto(wizardUrl);
  await expect(finalize.getByText("Not started", { exact: true })).toBeVisible();
  await finalize.getByRole("checkbox", {
    name: "I understand that Finalization creates a Period Lock for this snapshot.",
  }).check();
  await finalize.getByRole("button", { name: "Finalize and lock period" }).click();
  await expect(finalize.getByRole("button", { name: "Unlock period" })).toBeVisible();
  await expect(finalize.getByText("Done", { exact: true })).toBeVisible();
  await expect(generate.getByRole("button", { name: "Generate / regenerate draft" })).toBeDisabled();
});
