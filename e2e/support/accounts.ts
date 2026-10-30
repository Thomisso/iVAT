import { expect, type Page } from "@playwright/test";
import type { AccountFixtureInput } from "../../tests/support/accounts";
import { provisionBrowserAccountFixture } from "../../tests/support/e2e";

/** Privately sets up an account, signs in through the English UI and opens Company setup. */
export async function provisionAndLogIn(page: Page, input: AccountFixtureInput) {
  await provisionBrowserAccountFixture(input);
  await page.goto("/login");
  await page.getByLabel("Email").fill(input.email);
  await page.getByLabel("Password").fill(input.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/companies/new");
}
