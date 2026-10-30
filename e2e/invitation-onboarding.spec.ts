import { provisionAndLogIn } from "./support/accounts";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const administratorPassword = "Playwright-password-76";
const existingPassword = "Existing-password-84";

async function english(context: BrowserContext, baseURL: string) {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
}

async function provisionAdministrator(page: Page, organization: string, email: string, password = administratorPassword) {
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
  await expect(page.getByRole("heading", { name: "AI processing" })).toBeVisible();
  await page.getByRole("link", { name: "Continue to Company" }).click();
  await expect(page).toHaveURL(new RegExp(`/companies/${companyId}$`));
  return companyId;
}

async function invite(page: Page, companyId: string, email: string) {
  await page.goto(`/companies/${companyId}/members`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Invite user" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: email }).getByText("Pending", { exact: true }).last())
    .toBeVisible();
}

async function invitationLink(email: string, excludedMessageId = "") {
  const mailpit = process.env.MAILPIT_URL;
  if (!mailpit) throw new Error("MAILPIT_URL is required for invitation acceptance coverage");
  let messageId = "";
  await expect.poll(async () => {
    const response = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    const listing = await response.json() as { messages: { ID: string }[] };
    messageId = listing.messages.find((message) => message.ID !== excludedMessageId)?.ID ?? "";
    return messageId;
  }).not.toBe("");
  const response = await fetch(`${mailpit}/api/v1/message/${messageId}`);
  const message = await response.json() as { HTML: string };
  const href = [...message.HTML.matchAll(/href="([^"]+)"/g)]
    .map((match) => match[1].replaceAll("&amp;", "&"))
    .find((candidate) => {
      try {
        return new URL(candidate).pathname === "/auth/callback";
      } catch {
        return false;
      }
    });
  if (!href) throw new Error("Rendered invitation email has no absolute Auth callback link");
  return { href, messageId };
}

test("rendered invitation emails onboard new and existing Users with the right credentials", async ({ baseURL, browser }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const administratorEmail = `invitation-administrator-${run}@example.test`;
  const companyName = `Invitation Company ${run}`;
  const administratorContext = await browser.newContext();
  await english(administratorContext, baseURL);
  const administratorPage = await administratorContext.newPage();
  const failedAssets: string[] = [];
  administratorPage.on("requestfailed", (request) => {
    const url = new URL(request.url());
    const error = request.failure()?.errorText;
    if (url.pathname.startsWith("/_next/static/") && error !== "net::ERR_ABORTED") {
      failedAssets.push(`${url.pathname}: ${error}`);
    }
  });
  await provisionAdministrator(administratorPage, `Invitation Organization ${run}`, administratorEmail);
  const companyId = await createCompany(administratorPage, companyName, `${Date.now()}`.slice(-8));
  // Send the hostile headers to the real invitation action only. Applying
  // them to page resources makes Chromium reject lazy chunks with ERR_INVALID_ARGUMENT.
  await administratorPage.route(`**/companies/${companyId}/members`, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const response = await route.fetch({
      headers: {
        ...request.headers(),
        origin: "https://untrusted.example.test",
        "x-forwarded-host": "untrusted.example.test",
        "x-forwarded-proto": "https",
      },
    });
    await route.fulfill({ response });
  });

  const newEmail = `invitation-new-${run}@example.test`;
  await invite(administratorPage, companyId, newEmail);
  expect(failedAssets).toEqual([]);
  const unusedMessage = await invitationLink(newEmail);
  const unusedLink = new URL(unusedMessage.href);
  expect(unusedLink.origin).toBe(new URL(baseURL).origin);

  // Local Auth deliberately throttles repeat magic links for one address for one second.
  await administratorPage.waitForTimeout(1_100);
  await invite(administratorPage, companyId, newEmail);
  const newLink = new URL((await invitationLink(newEmail, unusedMessage.messageId)).href);
  expect(newLink.toString()).not.toBe(unusedLink.toString());
  expect(newLink.origin).toBe(new URL(baseURL).origin);
  expect(newLink.pathname).toBe("/auth/callback");
  expect(newLink.searchParams.get("token_hash")).toMatch(/^pkce_[0-9a-f]{56}$/);
  expect(newLink.searchParams.get("type")).toBe("magiclink");
  const newDestination = new URL(newLink.searchParams.get("next")!, baseURL);
  expect(newDestination.pathname).toBe("/invitations/accept");
  expect(newDestination.searchParams.get("token")).toMatch(/^[0-9a-f-]{72}$/);

  const newContext = await browser.newContext();
  await english(newContext, baseURL);
  const newPage = await newContext.newPage();
  await newPage.goto(newLink.toString());
  await expect(newPage.getByRole("heading", { name: "Set your password" })).toBeVisible();
  await newPage.getByLabel("New password").fill("12345678");
  await newPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(newPage).toHaveURL(new RegExp(`/companies/${companyId}$`));
  await expect(newPage.getByRole("navigation", { name: "Company navigation" })).toBeVisible();
  await newPage.goto(newDestination.toString());
  await expect(newPage.getByText("This invitation link has already been used. Ask an Administrator to send a new invitation."))
    .toBeVisible();

  const existingEmail = `invitation-existing-${run}@example.test`;
  const existingSetupContext = await browser.newContext();
  await english(existingSetupContext, baseURL);
  const existingSetupPage = await existingSetupContext.newPage();
  await provisionAdministrator(existingSetupPage, `Existing Organization ${run}`, existingEmail, existingPassword);
  await invite(administratorPage, companyId, existingEmail);
  const existingLink = (await invitationLink(existingEmail)).href;

  const existingContext = await browser.newContext();
  await english(existingContext, baseURL);
  const existingPage = await existingContext.newPage();
  await existingPage.goto(existingLink);
  await expect(existingPage.getByRole("heading", { name: "Log in to accept" })).toBeVisible();
  await expect(existingPage.getByLabel("Email")).toHaveValue(existingEmail);
  await existingPage.getByLabel("Password").fill(existingPassword);
  await existingPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(existingPage).toHaveURL(new RegExp(`/companies/${companyId}$`));
  await existingPage.getByRole("button", { name: "Open account menu" }).click();
  await existingPage.getByRole("menuitem", { name: "Log out" }).click();
  await existingPage.getByLabel("Email").fill(existingEmail);
  await existingPage.getByLabel("Password").fill(existingPassword);
  await existingPage.getByRole("button", { name: "Log in" }).click();
  await expect(existingPage).toHaveURL(new RegExp(`/companies/${companyId}$`));

  const invalidContext = await browser.newContext();
  await english(invalidContext, baseURL);
  const invalidPage = await invalidContext.newPage();
  await invalidPage.goto("/invitations/accept?token=invalid");
  await expect(invalidPage.getByText("This invitation link is invalid. Ask an Administrator to send a new invitation."))
    .toBeVisible();

  expect(failedAssets).toEqual([]);

  await Promise.all([
    administratorContext.close(),
    newContext.close(),
    existingSetupContext.close(),
    existingContext.close(),
    invalidContext.close(),
  ]);
});
