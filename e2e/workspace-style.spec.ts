import fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { workspaceBrowserFixture } from "../tests/support/workspace-browser";
import { listCompanyDocuments } from "../src/application/documents";
import { closeFailedExportAttempt } from "../src/application/processing-administration";
import { addBrowserFailedExportAttemptFixture, browserUserClient, promoteBrowserSuperAdminFixture } from "../tests/support/e2e";
import { totp } from "../tests/support/totp";

test("shared workspaces preserve readable CS/EN layouts and actual human review", async ({ baseURL, context, page }) => {
  if (!baseURL) throw new Error("Browser base URL missing");
  const fixture = await workspaceBrowserFixture();
  await fs.mkdir("test-results", { recursive: true });
  await fs.writeFile("test-results/workspace-fixture.json", JSON.stringify({ email: fixture.email, password: fixture.password, companyId: fixture.companyId, organizationId: fixture.organizationId, documentId: fixture.documentId }), { mode: 0o600 });
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
  const company = `/companies/${fixture.companyId}`;
  const review = `${company}/documents/${fixture.documentId}`;
  const routes = [["upload", `${company}/upload`], ["overview", company], ["documents", `${company}/documents`], ["review", review], ["vat", `${company}/vat-reports?period=2026-10`], ["control-statement", `${company}/vat-reports/2026-10/control-statement`], ["organization", `/organizations/${fixture.organizationId}/members`]] as const;
  for (const locale of ["en", "cs"] as const) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: new URL(baseURL).origin }]);
    for (const [name, href] of routes) {
      await page.goto(href);
      await expect(page.getByRole("main")).toHaveCount(1);
      expect(await page.locator(".company-shell").evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgb(246, 246, 243)");
      for (const width of [360, 720, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
        await expect(page.getByRole("main").getByRole("heading", { level: 1 }).first()).toBeVisible();
        if (name === "upload" && width === 360) {
          const description = await page.locator(".iv-drop-text").boundingBox();
          const picker = await page.locator(".iv-drop .iv-btn").boundingBox();
          if (!description || !picker) throw new Error("Visible file picker missing");
          expect(picker.y).toBeGreaterThanOrEqual(description.y + description.height);
        }
        if (name === "upload" || width === 360 || width === 1440) await page.screenshot({ path: `test-results/workspace-${name}-${locale}-${width}.png`, fullPage: true });
      }
      if (name === "upload") {
        expect(await page.getByRole("heading", { level: 1 }).first().evaluate(node => getComputedStyle(node).color)).toBe("rgb(28, 28, 26)");
        expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
      }
      if (name === "review") {
        await expect(page.locator(".correction-form.is-ai")).toBeVisible();
        await expect(page.getByRole("button", { name: locale === "en" ? /^Approve version/ : /^Schválit verzi/ })).toBeVisible();
      }
    }
  }
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: new URL(baseURL).origin }]);
  await page.goto(review);
  await page.getByRole("button", { name: /^Approve version/ }).click();
  await expect.poll(async () => (await listCompanyDocuments(fixture.client, fixture.companyId)).find(document => document.id === fixture.documentId)?.status).toBe("approved");
  await promoteBrowserSuperAdminFixture(fixture.email);
  await page.goto("/mfa/enroll");
  await page.getByRole("button", { name: "Start setup" }).click();
  const secret = await page.locator("code").textContent();
  if (!secret) throw new Error("Missing local Auth TOTP secret");
  await page.getByLabel("Authenticator code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  const client = await browserUserClient(await context.cookies());
  const failure = await addBrowserFailedExportAttemptFixture(fixture.companyId);
  try {
    for (const locale of ["en", "cs"] as const) {
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: new URL(baseURL).origin }]);
      await page.goto("/platform/administration");
      await expect(page.locator(".operational-problem").filter({ hasText: failure.exportId })).toBeVisible();
      for (const width of [360, 720, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.getByRole("main")).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({ path: `test-results/workspace-platform-${locale}-${width}.png`, fullPage: true });
      }
    }
  } finally {
    expect(await closeFailedExportAttempt(client, failure.jobId, 0)).toEqual({ ok: true, value: null });
  }
});

test("integrated recovery entry screens inherit the common light authentication frame", async ({ baseURL, context, page }) => {
  if (!baseURL) throw new Error("Browser base URL missing");
  await page.emulateMedia({ colorScheme: "dark" });
  for (const locale of ["cs", "en"] as const) {
    await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: new URL(baseURL).origin }]);
    for (const path of ["forgot", "reset"]) {
      await page.setViewportSize({ width: 360, height: 900 });
      await page.goto(`/password/${path}`);
      await expect(page.locator(".focused-shell-panel").getByRole("link", { name: "iVAT", exact: true })).toBeVisible();
      await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
      await page.screenshot({ path: `test-results/workspace-recovery-${path}-${locale}-360.png`, fullPage: true });
    }
  }
});
