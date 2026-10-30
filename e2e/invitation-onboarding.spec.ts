import { readFile } from "node:fs/promises";
import path from "node:path";
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
        return new URL(candidate).pathname === "/invitations/accept";
      } catch {
        return false;
      }
    });
  if (!href) throw new Error("Rendered invitation email has no absolute invitation link");
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
  await administratorPage.route(`**/companies/${companyId}/settings/users`, async (route) => {
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

  await invite(administratorPage, companyId, newEmail);
  const newLink = new URL((await invitationLink(newEmail, unusedMessage.messageId)).href);
  expect(newLink.toString()).not.toBe(unusedLink.toString());
  expect(newLink.origin).toBe(new URL(baseURL).origin);
  expect(newLink.pathname).toBe("/invitations/accept");
  expect(newLink.search).toBe("");
  expect(new URLSearchParams(newLink.hash.slice(1)).get("token")).toBeTruthy();
  const newDestination = newLink;

  const newContext = await browser.newContext();
  await english(newContext, baseURL);
  const newPage = await newContext.newPage();
  await newPage.goto(newLink.toString());
  await expect(newPage.getByRole("heading", { name: "Set your password" })).toBeVisible();
  expect((await newContext.cookies()).filter(cookie => cookie.name.startsWith("sb-"))).toEqual([]);
  await newPage.reload();
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
  const logDirectory = process.env.IVAT_E2E_SERVICE_LOG_DIRECTORY;
  if (!logDirectory) throw new Error("Acceptance service logs are required for credential privacy coverage");
  const serverLog = await readFile(path.join(logDirectory, "next.log"), "utf8");
  for (const secret of [new URLSearchParams(newLink.hash.slice(1)).get("token")!, "12345678", existingPassword]) {
    expect(serverLog).not.toContain(secret);
  }

  await Promise.all([
    administratorContext.close(),
    newContext.close(),
    existingSetupContext.close(),
    existingContext.close(),
    invalidContext.close(),
  ]);
});

test("copied invitation links survive reload, replacement and cancellation without sending email", async ({ baseURL, browser, context, page }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await english(context, baseURL);
  const run = crypto.randomUUID();
  await provisionAdministrator(page, `Link Organization ${run}`, `link-admin-${run}@example.test`);
  const companyId = await createCompany(page, `Link Company ${run}`, `${Date.now()}`.slice(-8));
  await page.goto(`/companies/${companyId}/settings/users`);
  const email = `link-invitee-${run}@example.test`;
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Generate link", exact: true }).click();
  const pending = () => page.getByRole("listitem").filter({ hasText: email }).filter({ hasText: "Pending" });
  await expect(pending()).toBeVisible();
  const firstLink = await pending().getByLabel("Invitation link").inputValue();
  const firstExpiry = await pending().getByText(/^Expires /).innerText();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await pending().getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(pending().getByRole("status")).toHaveText("Link copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(firstLink);
  await page.reload();
  await expect(pending().getByLabel("Invitation link")).toHaveValue(firstLink);
  await expect(pending().getByText(/^Expires /)).toHaveText(firstExpiry);
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

  const visitor = await browser.newContext();
  await english(visitor, baseURL);
  const invitee = await visitor.newPage();
  await invitee.goto(firstLink);
  await expect(invitee.getByRole("heading", { name: "Set your password" })).toBeVisible();
  expect((await visitor.cookies()).filter(cookie => cookie.name.startsWith("sb-"))).toEqual([]);
  await pending().getByRole("button", { name: "Generate replacement link", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: email }).filter({ hasText: "Replaced" })).toBeVisible();
  await expect(pending()).toBeVisible();
  const replacement = await pending().getByLabel("Invitation link").inputValue();
  expect(replacement).not.toBe(firstLink);
  await invitee.goto(firstLink);
  await invitee.reload();
  await expect(invitee.getByText("This invitation was replaced. Use the new link from the Administrator.")).toBeVisible();
  await pending().getByRole("button", { name: "Cancel invitation", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: email }).filter({ hasText: "Cancelled" })).toBeVisible();
  await invitee.goto(replacement);
  await expect(invitee.getByText("This invitation was cancelled. Ask an Administrator for a new invitation.")).toBeVisible();
  const mailpit = process.env.MAILPIT_URL;
  if (!mailpit) throw new Error("MAILPIT_URL is required");
  const messages = await (await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json() as { messages: unknown[] };
  expect(messages.messages).toEqual([]);
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Čeština", exact: true }).click();
  await expect(page.getByRole("button", { name: "Vygenerovat link", exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: email }).filter({ hasText: "Zrušena" })).toBeVisible();
  await visitor.close();
});
