import { expect, it } from "vitest";
import { getCompany, updateCompany } from "@/application/companies";
import { prefillCompanyFromAres } from "@/application/ares";
import { aresRegistry } from "@/ares/registry";
import { administratorWithCompany, companyMember, companyDetails } from "../tests/support/fixtures";
import { provisionedUser } from "../tests/support/clients";
import { baseUrl, httpAs } from "./support/http";

it("serves actual localized login and independent liveness/Auth dependency responses", async () => {
  for (const [locale, label] of [["cs", "Přihlášení"], ["en", "Sign in"]]) {
    const response = await fetch(`${baseUrl()}/login`, { headers: { Cookie: `NEXT_LOCALE=${locale}` }, redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain(label);
  }
  const live = await fetch(`${baseUrl()}/health/live`);
  expect(live.status).toBe(200);
  expect(await live.json()).toEqual({ status: "ok" });
  const auth = await fetch(`${baseUrl()}/health/auth`);
  expect(auth.status).toBe(200);
  expect(auth.headers.get("cache-control")).toContain("no-store");
});

it("uses real Auth cookies for SSR and enforces ordinary-member and foreign-Organization authority", async () => {
  const owner = await administratorWithCompany("HTTP own organization");
  const member = await companyMember(owner);
  const stranger = await provisionedUser("HTTP foreign organization");
  const path = `/companies/${owner.companyId}/documents`;
  const anonymousUrl = new URL(path, baseUrl());
  const anonymous = await fetch(anonymousUrl, { redirect: "manual" });
  expect(anonymous.status).toBe(307);
  const location = anonymous.headers.get("location");
  expect(location?.trim()).toBeTruthy();
  const destination = new URL(location!, anonymousUrl);
  expect(destination.origin).toBe(anonymousUrl.origin);
  expect(destination.pathname).toBe("/login");
  for (const user of [owner, member]) {
    const response = await (await httpAs(user.client))(path);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Documents");
  }
  expect(await getCompany(stranger.client, owner.companyId)).toBeNull();
  const foreign = await (await httpAs(stranger.client))(path);
  expect(foreign.status).toBe(404);
  expect(await foreign.text()).not.toContain("HTTP own organization");
  const refused = await updateCompany(member.client, { companyId: owner.companyId, ...companyDetails({ name: "FORBIDDEN HTTP MUTATION" }) });
  expect(refused).toEqual({ ok: false, error: "forbidden" });
  expect((await getCompany(owner.client, owner.companyId))?.name).not.toBe("FORBIDDEN HTTP MUTATION");
});

it("runs the real ARES adapter over the existing HTTP stand-in for structured identity and refusal", async () => {
  expect(process.env.ARES_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
  const identity = await prefillCompanyFromAres(aresRegistry(), "90000001");
  expect(identity).toEqual({ ok: true, value: expect.objectContaining({ personType: "natural", firstName: "Marie Anna", lastName: "Nováková", streetName: "Dlouhá", orientationNumber: "53A" }) });
  expect(await prefillCompanyFromAres(aresRegistry(), "90000003")).toEqual({ ok: false, error: "ares_unavailable" });
});
