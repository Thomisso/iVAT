import { expect, it } from "vitest";
import { beginTotpEnrollment, completeTotpEnrollment } from "@/application/mfa";
import { getOperationalAlertPreference } from "@/application/operational-email-alerts";
import { provisionedUser } from "../tests/support/clients";
import { systemClient } from "../tests/support/worker";
import { promoteSuperAdministratorFixture } from "../tests/support/platform";
import { totp } from "../tests/support/totp";
import { baseUrl, httpAs } from "./support/http";

it("submits the opt-in/out preference over real MFA-authorized HTTP and refuses other Roles", async () => {
  const operator = await provisionedUser("HTTP operational alerts");
  await promoteSuperAdministratorFixture(operator.userId);
  const anonymous = await fetch(new URL("/platform/settings", baseUrl()), { redirect: "manual" });
  expect(anonymous.status).toBe(307);
  expect(new URL(anonymous.headers.get("location")!, baseUrl()).pathname).toBe("/login");
  const weak = await (await httpAs(operator.client))("/platform/settings");
  expect(weak.status).toBe(307);
  expect(new URL(weak.headers.get("location")!, baseUrl()).pathname).toBe("/mfa/enroll");
  const enrollment = await beginTotpEnrollment(operator.client);
  if (!enrollment.ok) throw new Error(enrollment.error);
  const enrolled = await completeTotpEnrollment(operator.client, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) });
  if (!enrolled.ok) throw new Error(enrolled.error);
  try {
    for (const [locale, title] of [["en", "Operational email alerts"], ["cs", "Provozní upozornění e-mailem"]]) {
      const request = await httpAs(operator.client, locale);
      const response = await request("/platform/settings"); expect(response.status).toBe(200);
      const html = await response.text(); expect(html).toContain(title);
      const data = preferenceForm(html); data.set("enabled", "on");
      // Arbitrary form addresses are never a recipient input.
      data.set("email", "external@example.test");
      const saved = await request("/platform/settings", { method: "POST", headers: { Origin: baseUrl() }, body: data });
      expect(saved.status).toBe(200);
      expect(await getOperationalAlertPreference(operator.client)).toEqual({ ok: true, value: { enabled: true, locale } });
      const disabled = preferenceForm(await saved.text()); disabled.delete("enabled");
      const off = await request("/platform/settings", { method: "POST", headers: { Origin: baseUrl() }, body: disabled });
      expect(off.status).toBe(200);
      expect(await getOperationalAlertPreference(operator.client)).toEqual({ ok: true, value: { enabled: false, locale } });
    }
    const ordinary = await provisionedUser("HTTP ordinary alert refusal");
    expect((await (await httpAs(ordinary.client))("/platform/settings")).status).toBe(404);
    const remediation = await fetch(new URL("/platform/ai-settings", baseUrl()), { redirect: "manual" });
    expect(remediation.status).toBe(307);
  } finally { await systemClient().auth.admin.deleteUser(operator.userId); }
});

function preferenceForm(html: string) {
  const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g)?.find(item => item.includes('name="enabled"'));
  expect(form).toBeDefined();
  const data = new FormData();
  const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const input of form!.matchAll(/<input\b[^>]*>/g)) {
    const name = input[0].match(/\bname="([^"]*)"/)?.[1];
    const value = input[0].match(/\bvalue="([^"]*)"/)?.[1] ?? "";
    if (name && !input[0].includes('type="checkbox"')) data.append(decode(name), decode(value));
  }
  return data;
}
