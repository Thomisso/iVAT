import { expect, test, type Locator, type Page } from "@playwright/test";

const password = "Playwright-password-125";
const desktop = { width: 1440, height: 900 };
const mobile = { width: 360, height: 800 };

async function signUp(page: Page, organization: string, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Organization name").fill(organization);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/companies\/new$/);
}

async function createCompany(page: Page, name: string, ico: string) {
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

test("administration uses a persistent side navigation and settings use the desktop width", async ({
  baseURL,
  context,
  page,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const organizationName = `Layout Organization ${run}`;
  await signUp(page, organizationName, `desktop-layout-${run}@example.test`);
  const companyId = await createCompany(page, `Layout Company ${run}`, `${Date.now()}`.slice(-8));

  await page.setViewportSize(desktop);
  await page.goto(`/companies/${companyId}`);
  await expect(page.getByRole("button", { name: "Open administration menu" })).toHaveCount(0);
  const administration = page.getByRole("navigation", { name: "Administration" });
  await expect(administration).toBeVisible();
  await expect(
    administration.getByRole("group", { name: "Company administration" }).getByRole("link", { name: "Users", exact: true }),
  ).toHaveAttribute(
    "href",
    `/companies/${companyId}/settings/users`,
  );
  const organizationGroup = administration.getByRole("group", { name: organizationName });
  await expect(organizationGroup.getByRole("link", { name: "Users", exact: true })).toBeVisible();
  await expect(organizationGroup.getByRole("link", { name: "Audit log", exact: true })).toBeVisible();
  await expect(administration.getByRole("link", { name: "Platform overview" })).toHaveCount(0);
  const companyNavigation = await box(page.getByRole("navigation", { name: "Company navigation" }));
  const administrationBox = await box(administration);
  expect(administrationBox.x).toBe(companyNavigation.x);
  expect(administrationBox.y).toBeGreaterThanOrEqual(companyNavigation.y + companyNavigation.height);

  await page.goto(`/companies/${companyId}/settings/company`);
  const settingsNavigation = page.getByRole("navigation", { name: "Company settings sections" });
  await expect(settingsNavigation.getByRole("link", { name: "Company details" })).toHaveAttribute("aria-current", "true");
  await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
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
  const mobileAdministration = page.getByRole("navigation", { name: "Administration" });
  await expect(mobileAdministration).toBeVisible();
  await mobileAdministration.getByRole("group", { name: organizationName }).getByRole("link", { name: "Audit log", exact: true }).click();
  await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]+\/audit-log$/);
  await expect(page.getByRole("navigation", { name: "Organization navigation" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize(desktop);
  const organizationAdministration = page.getByRole("navigation", { name: "Administration" });
  await expect(organizationAdministration.getByRole("group", { name: organizationName })).toBeVisible();
  await expect(organizationAdministration.getByRole("group", { name: "Company administration" })).toHaveCount(0);
  await expect(page.locator('[aria-current="page"]')).toHaveCount(1);

  await page.goto(`/companies/${companyId}/settings`);
  await expect(page.getByRole("navigation", { name: "Administration" })).toHaveCount(1);
});
