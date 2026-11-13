import { inject, expect, it } from "vitest";
import { Client as DatabaseClient } from "pg";
import { listPlatformOrganizationCompanies } from "@/application/platform-administration";
import { beginTotpEnrollment, completeTotpEnrollment } from "@/application/mfa";
import { provisionedUser } from "../tests/support/clients";
import { promoteSuperAdministratorFixture } from "../tests/support/platform";
import { totp } from "../tests/support/totp";
import { baseUrl, httpAs, inputTag } from "./support/http";

it("creates an empty Organization through localized MFA-authorized HTTP and retains refused input", async () => {
  const customerName = `HTTP created customer ${crypto.randomUUID()}`;
  const operator = await provisionedUser("HTTP platform operator");
  await promoteSuperAdministratorFixture(operator.userId);
  const anonymous = await fetch(new URL("/platform/organizations/new", baseUrl()), { redirect: "manual" });
  expect(anonymous.status).toBe(307);
  expect(new URL(anonymous.headers.get("location")!, baseUrl()).pathname).toBe("/login");
  const weak = await (await httpAs(operator.client))("/platform/organizations/new");
  expect(weak.status).toBe(307);
  expect(new URL(weak.headers.get("location")!, baseUrl()).pathname).toBe("/mfa/enroll");
  const enrollment = await beginTotpEnrollment(operator.client);
  if (!enrollment.ok) throw new Error(enrollment.error);
  const verified = await completeTotpEnrollment(operator.client, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) });
  if (!verified.ok) throw new Error(verified.error);
  for (const [locale, title] of [["en", "Create Organization"], ["cs", "Vytvořit organizaci"]]) {
    const request = await httpAs(operator.client, locale);
    const response = await request("/platform/organizations/new");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html.includes(title)).toBe(true);
    expect(inputTag(html, "name")).toContain('required=""');
    expect(html.includes('name="email"')).toBe(false);
    if (locale === "en") {
      const form = organizationForm(html);
      form.set("name", "   ");
      const invalid = await request("/platform/organizations/new", { method: "POST", headers: { Origin: baseUrl() }, body: form });
      expect(invalid.status).toBe(200);
      const invalidHtml = await invalid.text();
      expect(invalidHtml.includes("Enter the name of your organization.")).toBe(true);
      expect(/<input[^>]*name="name"[^>]*value="   "/.test(invalidHtml)).toBe(true);

      const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
      await database.connect();
      try {
        await database.query(`create function private.test_reject_organization_create_292() returns trigger
          language plpgsql as $$ begin if new.name = 'Storage failure customer' then
          raise exception 'controlled storage failure'; end if; return new; end $$;
          create trigger test_reject_organization_create_292 before insert on public.organization
          for each row execute function private.test_reject_organization_create_292();`);
        const failing = organizationForm(invalidHtml);
        failing.set("name", "  Storage failure customer  ");
        const failed = await request("/platform/organizations/new", { method: "POST", headers: { Origin: baseUrl() }, body: failing });
        expect(failed.status).toBe(200);
        const failedHtml = await failed.text();
        expect(failedHtml.includes("The Organization could not be saved. Please try again.")).toBe(true);
        expect(/<input[^>]*name="name"[^>]*value="  Storage failure customer  "/.test(failedHtml)).toBe(true);
      } finally {
        await database.query("drop trigger if exists test_reject_organization_create_292 on public.organization; drop function if exists private.test_reject_organization_create_292()");
        await database.end();
      }

      const valid = organizationForm(invalidHtml);
      valid.set("name", `  ${customerName}  `);
      const saved = await request("/platform/organizations/new", { method: "POST", headers: { Origin: baseUrl() }, body: valid });
      expect(saved.status).toBe(303);
      expect(saved.headers.get("location")).toBe("/platform/administration");
      const organizations = await listPlatformOrganizationCompanies(operator.client);
      if (!organizations.ok) throw new Error(organizations.error);
      expect(organizations.value.some(item => item.name === "Storage failure customer")).toBe(false);
      const organization = organizations.value.find(item => item.name === customerName);
      expect(organization).toEqual({ id: expect.any(String), name: customerName, blocked: false, companies: [] });
      const inventory = await request("/platform/administration");
      expect(inventory.status).toBe(200);
      const inventoryHtml = await inventory.text();
      expect(inventoryHtml.includes(`/organizations/${organization!.id}/users`)).toBe(true);
      expect(inventoryHtml.includes(`/companies/new?organizationId=${organization!.id}`)).toBe(true);
      const members = await request(`/organizations/${organization!.id}/users`);
      expect(members.status).toBe(200);
      expect((await members.text()).includes(customerName)).toBe(true);
      const company = await request(`/companies/new?organizationId=${organization!.id}`);
      expect(company.status).toBe(200);
      expect((await company.text()).includes(`<option value="${organization!.id}" selected=""`)).toBe(true);
    }
  }
  const ordinary = await provisionedUser("HTTP scoped Administrator");
  const refused = await (await httpAs(ordinary.client))("/platform/organizations/new");
  expect(refused.status).toBe(404);
});

/** Submit the real progressive-enhancement action descriptor emitted by React. */
function organizationForm(html: string) {
  const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g)?.find(item => item.includes('name="name"'));
  expect(Boolean(form)).toBe(true);
  const data = new FormData();
  const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const input of form!.matchAll(/<input\b[^>]*>/g)) {
    const name = input[0].match(/\bname="([^"]*)"/)?.[1];
    const value = input[0].match(/\bvalue="([^"]*)"/)?.[1] ?? "";
    if (name) data.append(decode(name), decode(value));
  }
  return data;
}
