import { provisionAndLogIn } from "./support/accounts";
import { expect, test, type Page } from "@playwright/test";
import { addBrowserUploadNotificationFixture } from "../tests/support/e2e";

const password = "Playwright-password-103";

async function createCompany(page: Page, name: string, ico: string) {
  await page.goto("/companies/new");
  await page.getByLabel("Company name").fill(name);
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
  return companyId;
}

test("the notification bell is a keyboard-accessible current-Company inbox", async ({
  baseURL,
  context,
  page,
}) => {
  test.setTimeout(120_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `notifications-${run}@example.test`;
  await provisionAndLogIn(page, { organizationName: `Notification Organization ${run}`, email, password });
  await expect(page).toHaveURL(/\/companies\/new$/);

  const digits = Date.now().toString().slice(-8);
  const companyA = await createCompany(page, `Notification Alpha ${run}`, digits);
  const companyB = await createCompany(
    page,
    `Notification Beta ${run}`,
    String(Number(digits) + 1).padStart(8, "0"),
  );
  const batchA = await addBrowserUploadNotificationFixture(companyA, email);
  const batchB = await addBrowserUploadNotificationFixture(companyB, email);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/companies/${companyA}`);
  await expect(page.getByRole("region", { name: "Upload notifications" })).toHaveCount(0);
  const bellA = page.getByRole("button", { name: "Notifications, 1 unread" });
  await bellA.focus();
  await page.keyboard.press("Enter");
  const panelA = page.getByRole("dialog", { name: "Upload notifications" });
  await expect(panelA).toBeVisible();
  await expect(panelA.getByRole("button", { name: "Close notifications" })).toBeFocused();
  await expect(panelA.locator(`a[href="/companies/${companyA}/upload-batches/${batchA}"]`)).toBeVisible();
  await expect(panelA.locator(`a[href="/companies/${companyB}/upload-batches/${batchB}"]`)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panelA).toBeHidden();
  await expect(bellA).toBeFocused();

  await bellA.click();
  await panelA.getByRole("button", { name: "Mark all as read" }).click();
  await expect(page.getByRole("button", { name: "Notifications, none unread" })).toBeVisible();
  await expect(panelA.getByText("No unread notifications", { exact: true })).toBeVisible();
  await panelA.getByRole("button", { name: "Dismiss all" }).click();
  await expect(panelA.getByText("No upload notifications for this Company.")).toBeVisible();
  await panelA.getByRole("button", { name: "Close notifications" }).click();

  await page.goto(`/companies/${companyB}`);
  await page.setViewportSize({ width: 360, height: 800 });
  const bellB = page.getByRole("button", { name: "Notifications, 1 unread" });
  await bellB.click();
  const panelB = page.getByRole("dialog", { name: "Upload notifications" });
  await expect(panelB).toBeVisible();
  expect(await panelB.boundingBox()).toEqual({ x: 0, y: 0, width: 360, height: 800 });
  await panelB.getByRole("link", { name: "Open batch" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyB}/upload-batches/${batchB}$`));
});
