import { provisionAndLogIn } from "./support/accounts";
import AxeBuilder from "@axe-core/playwright";
import { addBrowserUploadNotificationFixture } from "../tests/support/e2e";
import { expectCheckboxTextBeside } from "../tests/support/browser-layout";
import { expect, test, type Locator, type Page } from "@playwright/test";

const password = "Playwright-password-125";
const desktop = { width: 1440, height: 900 };
const mobile = { width: 360, height: 800 };

async function provisionAdministrator(page: Page, organization: string, email: string) {
  await provisionAndLogIn(page, { organizationName: organization, email, password });
  await expect(page).toHaveURL(/\/companies\/new$/);
}

async function createCompany(page: Page, name: string, ico: string, street = "Na Příkopě") {
  await page.getByLabel("Company name").fill(name);
  await page.getByLabel("IČO").fill(ico);
  await page.getByLabel("VAT ID").fill(`CZ${ico}`);
  await page.getByLabel("Street name").fill(street);
  await page.getByLabel("House number").fill("1");
  await page.getByLabel("City").fill("Praha");
  await page.getByLabel("Postal code").fill("11000");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/companies\/[0-9a-f-]+\/setup\/filing-frequency$/);
  const companyId = new URL(page.url()).pathname.split("/")[2];
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}/setup/ai-processing$`));
  return companyId;
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (!result) throw new Error("Element is not rendered");
  return result;
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
}

test("Settings keep scoped Organization discovery and use the desktop width", async ({
  baseURL,
  context,
  page,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const organizationName = `Layout Organization ${run}`;
  await provisionAdministrator(page, organizationName, `desktop-layout-${run}@example.test`);
  const companyId = await createCompany(page, `Layout Company ${run}`, `${Date.now()}`.slice(-8));

  await page.setViewportSize(desktop);
  await page.goto(`/companies/${companyId}`);
  await expect(page.getByRole("button", { name: "Open administration menu" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Administration" })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Company navigation" }).getByRole("link", { name: "Settings", exact: true }).click();
  const organizationArea = page.getByRole("region", { name: `Organization settings: ${organizationName}`, exact: true });
  await expect(organizationArea.getByRole("link", { name: /^Organization users/ })).toBeVisible();
  await expect(organizationArea.getByRole("link", { name: /^Organization audit/ })).toBeVisible();

  await page.goto(`/companies/${companyId}/settings/company`);
  const settingsNavigation = page.getByRole("navigation", { name: "Company settings sections" });
  await expect(settingsNavigation.getByRole("link", { name: "Company details" })).toHaveAttribute("aria-current", "page");
  await expect(settingsNavigation.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Company settings sections" })).toHaveCount(0);
  const section = page.getByRole("heading", { name: "Company details", level: 2 }).locator("xpath=ancestor::section");
  const [navigationBox, sectionBox, mainBox] = await Promise.all([
    box(settingsNavigation),
    box(section),
    box(page.getByRole("main")),
  ]);
  expect(navigationBox.x + navigationBox.width).toBeLessThanOrEqual(sectionBox.x);
  expect(Math.abs(navigationBox.y - sectionBox.y)).toBeLessThan(2);
  expect(mainBox.width).toBeGreaterThan(1150);
  expect(sectionBox.width).toBeGreaterThan(800);
  const [ico, name] = await Promise.all([box(page.getByLabel("IČO")), box(page.getByLabel("Company name"))]);
  expect(name.x).toBeGreaterThan(ico.x + ico.width);
  expect(Math.abs(name.y - ico.y)).toBeLessThan(2);
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ width: 900, height: 900 });
  const [tabletNavigation, tabletSection] = await Promise.all([box(settingsNavigation), box(section)]);
  expect(tabletNavigation.y + tabletNavigation.height).toBeLessThanOrEqual(tabletSection.y);
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize(mobile);
  await expect(settingsNavigation).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Company settings sections" })).toHaveCount(0);
  const [mobileIco, mobileName] = await Promise.all([box(page.getByLabel("IČO")), box(page.getByLabel("Company name"))]);
  expect(mobileName.y).toBeGreaterThan(mobileIco.y + mobileIco.height);
  await expectNoHorizontalOverflow(page);

  await page.goto(`/companies/${companyId}/settings`);
  await expect(organizationArea).toBeVisible();
  await organizationArea.getByRole("link", { name: /^Organization audit/ }).click();
  await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]+\/audit-log$/);
  await expect(page.getByRole("navigation", { name: "Organization navigation" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize(desktop);
  await expect(page.getByRole("navigation", { name: "Administration" })).toHaveCount(0);
  await expect(page.locator('[aria-current="page"]')).toHaveCount(1);

  await page.goto(`/companies/${companyId}/settings`);
  await expect(organizationArea).toBeVisible();
});

test("Reporting Year changes and deletion remain distinct and usable at every workspace width", async ({ baseURL, context, page }, testInfo) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = crypto.randomUUID();
  await provisionAdministrator(page, `Accounting and advisory Organization with a long descriptive name ${run}`, `layout-years-${run}@example.test`);
  const companyId = await createCompany(page, "Accounting Company with a long descriptive registered business name s.r.o.", Date.now().toString().slice(-8));
  await page.goto(`/companies/${companyId}/settings/vat`);
  const year = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric" }).format(new Date());
  const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: year, exact: true }) });
  const frequency = row.getByRole("combobox", { name: `Filing frequency of Reporting Year ${year}`, exact: true });
  const firstMonth = row.getByRole("combobox", { name: `First month of Reporting Year ${year}`, exact: true });
  const changeFrequency = row.getByRole("button", { name: "Change frequency", exact: true });
  const changeMonth = row.getByRole("button", { name: "Change first month", exact: true });
  await expect(changeFrequency).toBeVisible();
  for (const width of [360, 720, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const controls = [frequency, changeFrequency, firstMonth, changeMonth, row.getByRole("checkbox"), row.getByRole("button", { name: `Delete ${year}`, exact: true })];
    for (let index = 0; index < controls.length; index++) {
      await controls[index].scrollIntoViewIfNeeded();
      const bounds = await box(controls[index]);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      for (const other of controls.slice(index + 1)) {
        const otherBounds = await box(other);
        const overlap = Math.min(bounds.x + bounds.width, otherBounds.x + otherBounds.width) - Math.max(bounds.x, otherBounds.x) > 1
          && Math.min(bounds.y + bounds.height, otherBounds.y + otherBounds.height) - Math.max(bounds.y, otherBounds.y) > 1;
        expect(overlap).toBe(false);
      }
    }
    await frequency.focus();
    await page.keyboard.press("Tab");
    await expect(changeFrequency).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await testInfo.attach(`reporting-years-${width}`, { body: await page.locator("#reporting-years").screenshot({ path: testInfo.outputPath(`reporting-years-${width}.png`) }), contentType: "image/png" });
  }
  await frequency.selectOption("quarterly");
  const changedFrequency = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/companies/${companyId}/settings/vat`) && Boolean(response.request().postData()?.includes('frequency')));
  await changeFrequency.click();
  await changedFrequency;
  await page.reload();
  await expect(frequency).toHaveValue("quarterly");
  await firstMonth.selectOption("10");
  const changedMonth = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/companies/${companyId}/settings/vat`) && Boolean(response.request().postData()?.includes('firstMonth')));
  await changeMonth.click();
  await changedMonth;
  await page.reload();
  await expect(firstMonth).toHaveValue("10");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "cs", url: baseURL }]);
  await page.reload();
  for (const width of [360, 720, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(row.getByRole("button", { name: "Změnit četnost", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Změnit první měsíc", exact: true })).toBeVisible();
    await expectCheckboxTextBeside(row.getByRole("checkbox"));
    await expectNoHorizontalOverflow(page);
    if (width === 360 || width === 1440) await testInfo.attach(`reporting-years-cs-${width}`, { body: await page.locator("#reporting-years").screenshot({ path: testInfo.outputPath(`reporting-years-cs-${width}.png`) }), contentType: "image/png" });
  }
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  await page.reload();
  await row.getByRole("checkbox").check();
  await row.getByRole("button", { name: `Delete ${year}`, exact: true }).click();
  await expect(page.getByRole("rowheader", { name: year, exact: true })).toHaveCount(0);
});


test("multiline confirmations stay beside their controls and Finalization uses the workspace", async ({ baseURL, context, page }, testInfo) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = crypto.randomUUID();
  await provisionAdministrator(page, `Confirmation Organization ${run}`, `layout-confirm-${run}@example.test`);
  const companyId = await createCompany(page, "Company with a long registered street and multiline confirmations", Date.now().toString().slice(-8), "Nábřeží s dlouhým oficiálním názvem ulice");
  await page.goto(`/companies/${companyId}/settings/vat`);
  const override = page.getByRole("checkbox", { name: "Use a separate EPO address", exact: true });
  await expect(override).toBeVisible();
  for (const width of [360, 720, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectCheckboxTextBeside(override);
    await override.check();
    const confirmation = page.getByRole("checkbox", { name: "I confirm this separate address is the intended EPO filing address.", exact: true });
    await expectCheckboxTextBeside(confirmation);
    await expectNoHorizontalOverflow(page);
  }
  await page.goto(`/companies/${companyId}/vat-reports?period=2026-01`);
  await page.getByRole("button", { name: "Generate draft", exact: true }).click();
  const finalize = page.getByRole("button", { name: "Finalize and lock period", exact: true });
  const confirmation = page.getByRole("checkbox", { name: "I understand that Finalization creates a Period Lock for this snapshot.", exact: true });
  await expect(confirmation).toBeEnabled();
  for (const width of [360, 720, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectCheckboxTextBeside(confirmation);
    await confirmation.focus();
    await page.keyboard.press("Space");
    await expect(finalize).toBeEnabled();
    await page.keyboard.press("Space");
    await expect(finalize).toBeDisabled();
    await expectNoHorizontalOverflow(page);
    if (width === 1440) expect((await box(confirmation.locator("xpath=ancestor::fieldset"))).width).toBeGreaterThan(800);
    await testInfo.attach(`finalization-${width}`, { body: await confirmation.locator("xpath=ancestor::li").screenshot({ path: testInfo.outputPath(`finalization-${width}.png`) }), contentType: "image/png" });
  }
  await confirmation.check();
  await finalize.click();
  await expect(page.getByRole("button", { name: "Unlock period", exact: true })).toBeVisible();
  const notice = page.getByRole("status").filter({ hasText: "Unlocking allows Document changes again." });
  expect((await box(notice)).width).toBeGreaterThan(800);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.filter((issue) => issue.impact === "serious" || issue.impact === "critical")).toEqual([]);
  await testInfo.attach("finalization-unlock-wide", { body: await notice.locator("xpath=ancestor::li").screenshot({ path: testInfo.outputPath("finalization-unlock-wide.png") }), contentType: "image/png" });
  for (const locale of ["en", "cs"]) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL }]);
    await page.reload();
    const finalSection = page.getByRole("heading", { name: locale === "en" ? "Finalize" : "Finalizace", level: 2, exact: true }).locator("xpath=ancestor::li");
    const exports = finalSection.getByRole("button", { name: locale === "en" ? /^Export (VAT Return|Control Statement) XML$/ : /^Exportovat XML/ });
    await expect(exports).toHaveCount(2);
    await expect(finalSection.getByRole("note", { name: locale === "en" ? "Export timing warnings" : "Upozornění na termíny exportu", exact: true })).toHaveCount(2);
    for (const width of [360, 720, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const action of await exports.all()) {
        await action.scrollIntoViewIfNeeded();
        const bounds = await box(action);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        await action.focus();
        await expect(action).toBeFocused();
      }
      await testInfo.attach(`final-xml-${locale}-${width}`, { body: await finalSection.screenshot({ path: testInfo.outputPath(`final-xml-${locale}-${width}.png`) }), contentType: "image/png" });
      await expectNoHorizontalOverflow(page);
    }
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.filter((issue) => issue.impact === "serious" || issue.impact === "critical")).toEqual([]);
  }

});


test("Organization membership and batch deletion cards use the workspace without clipping long values", async ({ baseURL, context, page }, testInfo) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: baseURL }]);
  const run = crypto.randomUUID();
  const organizationName = `Accounting and advisory services for international businesses ${run}`;
  await provisionAdministrator(page, organizationName, `layout-members-${run}@example.test`);
  const companyId = await createCompany(page, "Long Company name used by the Organization accounting administrators", Date.now().toString().slice(-8));
  await page.goto(`/companies/${companyId}/settings`);
  const organizationArea = page.getByRole("region", { name: `Organization settings: ${organizationName}`, exact: true });
  const usersLink = organizationArea.getByRole("link", { name: /^Organization users/ });
  await expect(usersLink).toHaveAttribute("href", /^\/organizations\/[0-9a-f-]+\/users$/);
  await usersLink.click();
  await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]+\/users$/);
  const invitation = page.getByRole("heading", { name: "Invite user", exact: true }).locator("xpath=ancestor::section[1]");
  const active = page.getByRole("heading", { name: "Active users", exact: true }).locator("xpath=ancestor::section[1]").getByRole("listitem").first();
  await page.setViewportSize(desktop);
  expect((await box(invitation)).width).toBeGreaterThan(800);
  const email = `${"advisory".repeat(7)}@business-services.example.test`;
  await invitation.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await invitation.getByRole("button", { name: "Invite user", exact: true }).click();
  const pending = page.getByRole("heading", { name: "Pending invitations", exact: true }).locator("xpath=ancestor::section[1]").getByRole("listitem");
  await expect(pending.getByText(email, { exact: true })).toBeVisible();
  await page.reload();
  await expect(pending.getByText(email, { exact: true })).toBeVisible();
  for (const width of [360, 720, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const [heading, inviteBounds, activeBounds, pendingBounds] = await Promise.all([box(page.getByRole("heading", { level: 1 })), box(invitation), box(active), box(pending)]);
    expect(inviteBounds.x).toBe(heading.x);
    expect(activeBounds.x).toBe(heading.x);
    expect(pendingBounds.x).toBe(heading.x);
    if (width === 1440) {
      expect(activeBounds.width).toBeGreaterThan(800);
      expect(pendingBounds.width).toBeGreaterThan(800);
    }
    await invitation.getByRole("combobox", { name: "Role", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(invitation.getByRole("button", { name: "Invite user", exact: true })).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await testInfo.attach(`organization-members-${width}`, { body: await page.screenshot({ fullPage: true, path: testInfo.outputPath(`organization-members-${width}.png`) }), contentType: "image/png" });
  }
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((issue) => issue.impact === "serious" || issue.impact === "critical")).toEqual([]);
  const batchId = await addBrowserUploadNotificationFixture(companyId, `layout-members-${run}@example.test`);
  await page.goto(`/companies/${companyId}/upload-batches/${batchId}`);
  const deletion = page.getByRole("region", { name: "Delete batch", exact: true });
  for (const width of [360, 720, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const [header, card] = await Promise.all([box(page.getByRole("heading", { level: 1 })), box(deletion)]);
    expect(card.x).toBe(header.x);
    if (width === 1440) expect(card.width).toBeGreaterThan(800);
    await expectCheckboxTextBeside(deletion.getByRole("checkbox"));
    await expectNoHorizontalOverflow(page);
    await testInfo.attach(`batch-deletion-${width}`, { body: await deletion.screenshot({ path: testInfo.outputPath(`batch-deletion-${width}.png`) }), contentType: "image/png" });
  }
  await deletion.getByRole("checkbox").check();
  await deletion.getByRole("button", { name: "Delete batch", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/companies/${companyId}/upload`);
});
