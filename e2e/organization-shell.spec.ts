import { provisionAndLogIn } from "./support/accounts";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const password = "Playwright-password-76";

async function english(context: BrowserContext, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
}

async function provisionAdministrator(page: Page, organization: string, email: string) {
  await provisionAndLogIn(page, { organizationName: organization, email, password });
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
  await page.goto(`/companies/${companyId}`);
  return companyId;
}

test("Organization Administrator navigates the shared Organization shell and returns to the remembered Company", async ({
  baseURL,
  context,
  page,
}) => {
  await english(context, baseURL);
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const organizationName = `Ledger Organization ${run}`;
  const companyName = `Selected Company ${run}`;
  await provisionAdministrator(page, organizationName, `organization-shell-${run}@example.test`);
  const firstIco = Number(`${Date.now()}`.slice(-8));
  await createCompany(page, `First Company ${run}`, String(firstIco).padStart(8, "0"));
  await page.goto("/companies/new");
  const secondIco = firstIco === 99_999_999 ? firstIco - 1 : firstIco + 1;
  const companyId = await createCompany(page, companyName, String(secondIco).padStart(8, "0"));
  await expect(page.getByRole("button", { name: "Choose Company" })).toContainText(companyName);

  await page.getByRole("navigation", { name: "Company navigation" }).getByRole("link", { name: "Settings", exact: true }).click();
  const organizationMembersLink = page.locator('a[href^="/organizations/"][href$="/members"]');
  const membersHref = await organizationMembersLink.getAttribute("href");
  expect(membersHref).toMatch(/^\/organizations\/[0-9a-f-]+\/members$/);
  await organizationMembersLink.click();

  const organizationNavigation = page.getByRole("navigation", { name: "Organization navigation" });
  await expect(organizationNavigation).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Company navigation" })).toHaveCount(0);
  const visibleOrganizationTrigger = page.getByRole("button", { name: "Choose Organization" });
  await expect(visibleOrganizationTrigger).toContainText(organizationName);
  await expect(visibleOrganizationTrigger.getByText("Organization", { exact: true })).toBeVisible();
  await expect(organizationNavigation.getByRole("link", { name: "Users", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(organizationNavigation.getByRole("link", { name: "Platform overview" })).toHaveCount(0);
  await expect(page.getByRole("main")).toHaveCount(1);

  const heading = page.getByRole("heading", { name: `Users of ${organizationName}`, level: 1 });
  await expect(heading).toBeVisible();
  const main = page.getByRole("main");
  const inviteSection = page.getByRole("heading", { name: "Invite user" }).locator("xpath=ancestor::section");
  const alignedEdges = await Promise.all([
    main.locator(":scope > header").evaluate((node) => node.getBoundingClientRect().x),
    inviteSection.evaluate((node) => node.getBoundingClientRect().x),
  ]);
  expect(alignedEdges[0]).toBe(alignedEdges[1]);

  await organizationNavigation.getByRole("link", { name: "Audit log", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${membersHref!.replace(/\/members$/, "/audit-log")}$`));
  await expect(organizationNavigation.getByRole("link", { name: "Audit log", exact: true })).toHaveAttribute("aria-current", "page");

  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();

  const organizationTrigger = page.getByRole("button", { name: "Choose Organization" });
  await organizationTrigger.focus();
  await page.keyboard.press("ArrowDown");
  const organizationMenuItems = page.getByRole("menu", { name: "Choose Organization" }).getByRole("menuitem");
  await expect(organizationMenuItems.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(organizationMenuItems.last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(organizationTrigger).toBeFocused();

  const returnToCompany = page.getByRole("link", { name: "Return to Company work" });
  await expect(returnToCompany).toHaveAttribute("href", `/companies/${companyId}`);
  await returnToCompany.click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));
  await expect(page.getByRole("navigation", { name: "Company navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose Company" })).toContainText(companyName);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});
