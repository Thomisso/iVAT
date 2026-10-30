import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { asUserClient } from "../src/application/client";
import { createCompany } from "../src/application/companies";
import { listMyOrganizations } from "../src/application/organizations";
import type { Database } from "../src/lib/database.types";

const password = "Release-identity-password-162";

for (const locale of ["cs", "en"] as const) {
  test(`login and account menu identify the same installed application in ${locale}`, async ({ baseURL, context, page }) => {
    if (!baseURL) throw new Error("Browser base URL missing");
    const environment = Object.fromEntries((await fs.readFile(".env.local", "utf8")).split("\n").filter(Boolean).map(line => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    const service = createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const email = `release-${crypto.randomUUID()}@example.test`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { organization_name: "Release identity" } });
    if (created.error) throw created.error;
    let organizationId: string | undefined;
    let companyId: string | undefined;
    try {
      const client = asUserClient(createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      }));
      const signedIn = await client.auth.signInWithPassword({ email, password });
      if (signedIn.error) throw signedIn.error;
      organizationId = (await listMyOrganizations(client))[0].id;
      const company = await createCompany(client, {
        organizationId, name: "Release identity", ico: "27082440", vatId: "CZ27082440", personType: "legal",
        streetName: "Vinohradská", houseNumber: "12", orientationNumber: "", city: "Praha", postalCode: "12000", filingFrequency: "monthly",
      });
      if (!company.ok) throw new Error(company.error);
      companyId = company.value.id;
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: new URL(baseURL).origin }]);
      await page.goto("/login");
      const tag = process.env.TEST_RELEASE_TAG;
      const version = tag ? `${locale === "cs" ? "Verze" : "Version"} ${tag}` : locale === "cs" ? "Vývojová verze" : "Development version";
      await expect(page.getByText(version, { exact: true })).toBeVisible();
      if (tag) await expect(page.getByText(version, { exact: true })).toHaveAttribute("title", `${locale === "cs" ? "Revize" : "Revision"} ${process.env.TEST_RELEASE_REVISION}`);
      await page.getByLabel(locale === "cs" ? "E-mail" : "Email", { exact: true }).fill(email);
      await page.getByLabel(locale === "cs" ? "Heslo" : "Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: locale === "cs" ? "Přihlásit se" : "Log in", exact: true }).click();
      await expect(page).not.toHaveURL(/\/login/);
      await page.goto(`/companies/${companyId}`);
      await page.getByRole("button", { name: locale === "cs" ? "Otevřít nabídku účtu" : "Open account menu" }).click();
      const menu = page.getByRole("menu");
      await expect(menu.getByText(version, { exact: true })).toBeVisible();
      if (tag) await expect(menu.getByText(version, { exact: true })).toHaveAttribute("title", `${locale === "cs" ? "Revize" : "Revision"} ${process.env.TEST_RELEASE_REVISION}`);
    } finally {
      if (companyId) {
        const removed = await service.from("company").delete().eq("id", companyId);
        if (removed.error) throw removed.error;
      }
      const removed = await service.auth.admin.deleteUser(created.data.user.id);
      if (removed.error) throw removed.error;
      if (organizationId) {
        const deleted = await service.from("organization").delete().eq("id", organizationId);
        if (deleted.error) throw deleted.error;
      }
    }
  });
}
