import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { createManualDocument } from "@/application/documents";
import { resolveSecurityReturnTo } from "@/application/security-return";
import { createCompany } from "@/application/companies";
import { listMemberships, removeMembership } from "@/application/memberships";
import { administratorWithCompany, companyDetails, companyMember } from "./support/fixtures";
import { promotedSuperAdministrator } from "./support/platform";

it("returns from Security to the authorized Company page with its workflow context", async () => {
  const user = await administratorWithCompany();
  const origin = `/companies/${user.companyId}/vat-reports?period=2026-10#vat-step-review`;
  expect(await resolveSecurityReturnTo(user.client, origin, null)).toBe(origin);
});

it("restores Company Settings and unified Organization scope only under their own database authority", async () => {
  const user = await administratorWithCompany();
  const settings = `/companies/${user.companyId}/settings/users?scope=organization`;
  const organization = `/organizations/${user.organizationId}/users?scope=${user.companyId}`;
  expect(await resolveSecurityReturnTo(user.client, settings, null)).toBe(settings);
  expect(await resolveSecurityReturnTo(user.client, organization, null)).toBe(organization);
});

it("restores an existing Document with its workflow parent and falls back for a stale Document", async () => {
  const user = await administratorWithCompany();
  const created = await createManualDocument(user.client, { companyId: user.companyId, payload: SAMPLE_EXTRACTION });
  if (!created.ok) throw new Error(created.error);
  const origin = `/companies/${user.companyId}/documents/${created.value.id}?version=1&returnTo=${encodeURIComponent(`/companies/${user.companyId}/vat-reports?period=2026-10#vat-step-review`)}`;
  expect(await resolveSecurityReturnTo(user.client, origin, null)).toBe(origin);
  expect(await resolveSecurityReturnTo(user.client, `/companies/${user.companyId}/documents/00000000-0000-4000-8000-000000000001`, null))
    .toBe(`/companies/${user.companyId}`);
});

it("keeps a Company User out of administrative origins and revalidates revoked access", async () => {
  const owner = await administratorWithCompany();
  const member = await companyMember(owner);
  const fallback = `/companies/${owner.companyId}`;
  for (const origin of [
    `/companies/${owner.companyId}/settings/users`,
    `/organizations/${owner.organizationId}/users`,
    `/organizations/${owner.organizationId}/audit-log`,
    "/platform/settings",
    `/platform/companies/${owner.companyId}/members`,
  ]) expect(await resolveSecurityReturnTo(member.client, origin, null)).toBe(fallback);
  const origin = `/companies/${owner.companyId}/documents?view=review`;
  expect(await resolveSecurityReturnTo(member.client, origin, null)).toBe(origin);
  const membership = (await listMemberships(owner.client, { organizationId: owner.organizationId, companyId: owner.companyId })).find(item => item.userId === member.userId)!;
  expect(await removeMembership(owner.client, membership.id)).toEqual({ ok: true, value: null });
  expect(await resolveSecurityReturnTo(member.client, origin, { userId: member.userId, companyId: owner.companyId })).toBe("/");
});

it("does not mistake Company administration for Organization authority or an authorized broader filter", async () => {
  const owner = await administratorWithCompany();
  const member = await companyMember(owner, "administrator");
  const base = `/companies/${owner.companyId}/settings/users`;
  expect(await resolveSecurityReturnTo(member.client, base, null)).toBe(base);
  expect(await resolveSecurityReturnTo(member.client, `${base}?scope=organization`, null)).toBe(`/companies/${owner.companyId}`);
  expect(await resolveSecurityReturnTo(member.client, `/organizations/${owner.organizationId}/users?scope=${owner.companyId}`, null)).toBe(`/companies/${owner.companyId}`);
});

it("uses the same User's last accessible Company for direct, foreign and unsafe origins, otherwise the selector", async () => {
  const user = await administratorWithCompany();
  const other = await administratorWithCompany();
  const second = await createCompany(user.client, { organizationId: user.organizationId, ...companyDetails() });
  if (!second.ok) throw new Error(second.error);
  const remembered = { userId: user.userId, companyId: second.value.id };
  for (const target of [undefined, ["/platform"], "https://evil.test", "//evil.test", "/\\evil.test", "/%2f%2fevil.test", `/companies/${other.companyId}/documents`, `/companies/${user.companyId}/documents\n`, "/settings/security", `/companies/${user.companyId}/unknown`]) {
    expect(await resolveSecurityReturnTo(user.client, target, remembered)).toBe(`/companies/${second.value.id}`);
  }
  expect(await resolveSecurityReturnTo(user.client, undefined, { userId: other.userId, companyId: user.companyId })).toBe("/");
  expect(await resolveSecurityReturnTo(user.client, undefined, { userId: user.userId, companyId: other.companyId })).toBe("/");
});

it("restores MFA-verified Platform origins and scopes without adding tenant Memberships", async () => {
  const owner = await administratorWithCompany();
  const operator = await promotedSuperAdministrator("Return operator");
  for (const target of ["/platform/settings", "/platform/administration", "/platform/ai-settings", "/platform/ai-usage?from=2026-10-01&to=2026-10-31&groupBy=company", `/platform/companies/${owner.companyId}/history`, `/platform/companies/${owner.companyId}/members?scope=organization`, `/organizations/${owner.organizationId}/users?scope=${owner.companyId}`]) {
    expect(await resolveSecurityReturnTo(operator.client, target, null)).toBe(target);
  }
  expect((await listMemberships(owner.client, { organizationId: owner.organizationId, companyId: null })).some(item => item.userId === operator.userId)).toBe(false);
});

it("does not restore a missing VAT Report snapshot even in a valid Reporting Period", async () => {
  const user = await administratorWithCompany();
  expect(await resolveSecurityReturnTo(user.client, `/companies/${user.companyId}/vat-reports/2026-10/vat-return`, null)).toBe(`/companies/${user.companyId}`);
});

it("preserves blocked support and deleted history, while refusing unavailable work and deleted management", async () => {
  const { setPlatformOrganizationBlocked } = await import("@/application/platform-administration");
  const { exportCompanyData, softDeleteCompany } = await import("@/application/company-deletion");
  const { testWorker } = await import("./support/worker");
  const owner = await administratorWithCompany();
  const operator = await promotedSuperAdministrator("Unavailable origin operator");
  expect(await setPlatformOrganizationBlocked(operator.client, { organizationId: owner.organizationId, blocked: true })).toEqual({ ok: true, value: null });
  expect(await resolveSecurityReturnTo(owner.client, `/companies/${owner.companyId}/documents`, null)).toBe("/");
  const management = `/platform/companies/${owner.companyId}/members?scope=organization`;
  expect(await resolveSecurityReturnTo(operator.client, management, null)).toBe(management);
  expect(await setPlatformOrganizationBlocked(operator.client, { organizationId: owner.organizationId, blocked: false })).toEqual({ ok: true, value: null });
  const worker = testWorker();
  const exported = await exportCompanyData(operator.client, worker.jobs, { companyId: owner.companyId });
  if (!exported.ok) throw new Error(exported.error);
  expect(await worker.runJobs()).toEqual([]);
  expect((await softDeleteCompany(operator.client, { companyId: owner.companyId, exportId: exported.value.exportId })).ok).toBe(true);
  const history = `/platform/companies/${owner.companyId}/history`;
  expect(await resolveSecurityReturnTo(operator.client, history, null)).toBe(history);
  expect(await resolveSecurityReturnTo(operator.client, management, null)).toBe("/");
  expect(await resolveSecurityReturnTo(owner.client, `/companies/${owner.companyId}/documents`, { userId: owner.userId, companyId: owner.companyId })).toBe("/");
});
