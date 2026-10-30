import { expect, test } from "@playwright/test";

test("Export History shows a compact table and expandable filing details on desktop and mobile", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = crypto.randomUUID();
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(`History ${run}`);
  await page.getByLabel("Email").fill(`history-${run}@example.test`);
  await page.getByLabel("Password").fill("Playwright-password-1");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByLabel("Company name").fill(`History Company ${run}`);
  await page.getByLabel("IČO").fill("12345678");
  await page.getByLabel("VAT ID").fill("CZ12345678");
  await page.getByLabel("Street name").fill("Na Příkopě");
  await page.getByLabel("House number").fill("1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(/\/setup\/ai-processing$/);
  const companyUrl = page.url().replace(/\/setup\/ai-processing$/, "");
  await page.goto(`${companyUrl}/vat-reports?period=2026-01`);
  await page.getByRole("button", { name: "Generate draft", exact: true }).click();
  await page.getByRole("link", { name: "Open VAT Return", exact: true }).click();
  await page.getByLabel("Preparation date").fill("10.02.2026");
  await page.getByRole("combobox", { name: "Tax office", exact: true }).selectOption("451");
  await page.getByLabel("First name").fill("Jana");
  await page.getByLabel("Last name").fill("Nováková");
  await page.getByLabel("Capacity (e.g. director)").fill("jednatelka");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download XML" }).click();
  await download;
  await page.getByRole("navigation", { name: "Reporting Period destinations" }).getByRole("link", { name: "Export history" }).click();
  const table = page.getByRole("table", { name: "Stored XML artifacts" });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Reporting Period", "Form", "Created", "Author", "Actions",
  ]);
  await expect(table.getByRole("cell", { name: "2026-01", exact: true })).toBeVisible();
  await expect(table.getByText("history-", { exact: false })).toBeVisible();
  await expect(table.locator("time")).toHaveText(/^\d{2}\.\d{2}\.\d{4}/);
  await expect(table.getByRole("link", { name: /DRAFT_DPHDP3/ })).toBeVisible();
  const disclosure = page.getByText("Filing details", { exact: true });
  const details = page.getByRole("definition").filter({ hasText: "10.02.2026" });
  await expect(details).toBeHidden();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await disclosure.click();
    await expect(details).toBeVisible();
    await expect(page.getByRole("definition").filter({ hasText: "Jana Nováková" })).toBeVisible();
    const overlaps = await page.locator(".export-artifact-details dl > div").evaluateAll((rows) => rows.some((row) => {
      const label = row.querySelector("dt")!.getBoundingClientRect();
      const value = row.querySelector("dd")!.getBoundingClientRect();
      return Math.min(label.right, value.right) > Math.max(label.left, value.left) && Math.min(label.bottom, value.bottom) > Math.max(label.top, value.top);
    }));
    expect(overlaps).toBe(false);
    await disclosure.click();
  }
});
