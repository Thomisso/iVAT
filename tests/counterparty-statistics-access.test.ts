import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import type { AppClient } from "@/application/client";
import { createCompany } from "@/application/companies";
import { createCounterparty, listCounterparties } from "@/application/counterparties";
import { getCounterpartyStatistics } from "@/application/counterparty-statistics";
import { getDocument, listExtractionVersions } from "@/application/documents";
import { acceptInvitation, changeMembershipRole, generateInvitationLink, listMemberships, previewMembershipChange, removeMembership } from "@/application/memberships";
import { beginTotpEnrollment, completeTotpEnrollment, setOrganizationMfaRequired } from "@/application/mfa";
import { beginBackupRecovery, finishBackupRecovery, startReplacementEnrollment, verifyReplacementAuthenticator } from "@/application/mfa-replacement";
import { requestPasswordRecovery, verifyPasswordRecovery } from "@/application/password-recovery";
import { setPlatformOrganizationBlocked } from "@/application/platform-administration";
import { anonymousClient, provisionedUser } from "./support/clients";
import { deletedTradeCompanyFixture, legacyCounterpartyTradeFixture, mismatchedTradeTenantFixture } from "./support/counterparty-statistics";
import { administratorWithCompany, companyDetails, companyMember, knownSupplierFixture } from "./support/fixtures";
import { mfaReplacementAuthenticationFixture, staleAccessTokenFixture } from "./support/mfa-replacement";
import { passwordRecoveryAuthenticationFixture, recoveryEmailFixture } from "./support/password-recovery";
import { promoteSuperAdministratorFixture, revokeSuperAdministratorFixture } from "./support/platform";
import { succeeded } from "./support/results";
import { totp } from "./support/totp";

async function tradeFixture() {
  const owner = await administratorWithCompany();
  await knownSupplierFixture(owner);
  const [party] = (await listCounterparties(owner.client, owner.companyId)).entries;
  const [documentId] = await legacyCounterpartyTradeFixture(owner, [{ payload: { ...SAMPLE_EXTRACTION, counterpartyLink: { id: party.id } } }]);
  return { ...owner, partyId: party.id, documentId };
}

async function readTrade(client: AppClient, target: Awaited<ReturnType<typeof tradeFixture>>, allowed: boolean) {
  const statistics = await getCounterpartyStatistics(client, target.companyId, target.partyId, { year: "2026" });
  const direct = await client.rpc("counterparty_statistics", { target_company_id: target.companyId, target_counterparty_id: target.partyId,
    date_from: "2026-01-01", date_to: "2026-12-31", trade_direction: "", original_currency: "", contribution: "dated", page_number: 1 });
  const document = await client.from("document").select("id").eq("id", target.documentId);
  const version = await client.from("extraction_version").select("document_id").eq("document_id", target.documentId);
  expect(document.error).toBeNull();
  expect(version.error).toBeNull();
  if (allowed) {
    expect(statistics).toMatchObject({ ok: true, value: { total: 1, entries: [{ documentId: target.documentId }],
      groups: [{ netAmount: "1000.00", vatAmount: "210.00", grossAmount: "1210.00" }] } });
    expect(direct.error).toBeNull();
    expect(direct.data).toMatchObject({ total: 1, entries: [{ documentId: target.documentId }] });
    expect(document.data).toEqual([{ id: target.documentId }]);
    expect(version.data).toEqual([{ document_id: target.documentId }]);
    expect(await getDocument(client, target.companyId, target.documentId)).toMatchObject({ id: target.documentId });
    expect(await listExtractionVersions(client, target.companyId, target.documentId)).toHaveLength(1);
  } else {
    expect(statistics).toEqual({ ok: false, error: "forbidden" });
    expect(direct.error?.code).toBe("42501");
    expect(document.data).toEqual([]);
    expect(version.data).toEqual([]);
    expect(await getDocument(client, target.companyId, target.documentId)).toBeNull();
    expect(await listExtractionVersions(client, target.companyId, target.documentId)).toEqual([]);
  }
}

it("uses live Memberships across direct reads and statistics after Role changes, revocation and a new grant", async () => {
  const owner = await tradeFixture();
  const member = await companyMember(owner);
  const outsider = await administratorWithCompany();
  await readTrade(member.client, owner, true);
  await readTrade(outsider.client, owner, false);
  await readTrade(owner.client, owner, true);
  const membership = (await listMemberships(owner.client, owner)).find(row => row.userId === member.userId)!;
  succeeded(await changeMembershipRole(owner.client, { membershipId: membership.id, role: "administrator" }));
  await readTrade(member.client, owner, true);
  succeeded(await changeMembershipRole(owner.client, { membershipId: membership.id, role: "user" }));
  await readTrade(member.client, owner, true);
  const impact = succeeded(await previewMembershipChange(owner.client, { membershipId: membership.id, role: null }));
  succeeded(await removeMembership(owner.client, membership.id, impact.confirmationToken));
  await readTrade(member.client, owner, false);
  const invitation = succeeded(await generateInvitationLink(owner.client, { organizationId: owner.organizationId, companyId: owner.companyId,
    email: member.email, role: "user", acceptUrl: "http://localhost/invitations/accept" }));
  succeeded(await acceptInvitation(member.client, invitation.token));
  await readTrade(member.client, owner, true);

  const inherited = succeeded(await generateInvitationLink(owner.client, { organizationId: owner.organizationId, companyId: null,
    email: member.email, role: "administrator", acceptUrl: "http://localhost/invitations/accept" }));
  succeeded(await acceptInvitation(member.client, inherited.token));
  const direct = (await listMemberships(owner.client, owner)).find(row => row.userId === member.userId)!;
  succeeded(await removeMembership(owner.client, direct.id));
  await readTrade(member.client, owner, true);
  const organizationMembership = (await listMemberships(owner.client, { organizationId: owner.organizationId, companyId: null }))
    .find(row => row.userId === member.userId)!;
  const finalImpact = succeeded(await previewMembershipChange(owner.client, { membershipId: organizationMembership.id, role: null }));
  succeeded(await removeMembership(owner.client, organizationMembership.id, finalImpact.confirmationToken));
  await readTrade(member.client, owner, false);
});

it("preserves native MFA, membership-free platform access and exact Company isolation", async () => {
  const owner = await tradeFixture();
  const member = await companyMember(owner);
  const sibling = succeeded(await createCompany(owner.client, { organizationId: owner.organizationId, ...companyDetails() }));
  const siblingParty = succeeded(await createCounterparty(owner.client, { companyId: sibling.id, name: "Sibling trade", supplier: true, customer: false }));
  const foreign = await administratorWithCompany();
  expect(await getCounterpartyStatistics(member.client, sibling.id, siblingParty.id, { year: "2026" })).toEqual({ ok: false, error: "forbidden" });
  expect(await getCounterpartyStatistics(owner.client, sibling.id, owner.partyId, { year: "2026" })).toEqual({ ok: false, error: "forbidden" });
  expect((await member.client.from("document").select("id").eq("id", owner.documentId).eq("organization_id", foreign.organizationId)).data).toEqual([]);
  expect((await member.client.from("extraction_version").select("id").eq("document_id", owner.documentId).eq("organization_id", foreign.organizationId)).data).toEqual([]);
  await readTrade(foreign.client, owner, false);

  const platform = await provisionedUser("Native trade platform reader");
  await promoteSuperAdministratorFixture(platform.userId);
  await readTrade(platform.client, owner, false);
  const enrollment = succeeded(await beginTotpEnrollment(platform.client));
  succeeded(await completeTotpEnrollment(platform.client, { factorId: enrollment.factorId, code: totp(enrollment.secret) }));
  await readTrade(platform.client, owner, true);
  await revokeSuperAdministratorFixture(platform.userId);
  await readTrade(platform.client, owner, false);
  await promoteSuperAdministratorFixture(platform.userId);
  await readTrade(platform.client, owner, true);

  succeeded(await setOrganizationMfaRequired(owner.client, { organizationId: owner.organizationId, required: true }));
  await readTrade(member.client, owner, false);
  const memberAal1 = await staleAccessTokenFixture(member.client);
  const memberEnrollment = succeeded(await beginTotpEnrollment(member.client));
  succeeded(await completeTotpEnrollment(member.client, { factorId: memberEnrollment.factorId, code: totp(memberEnrollment.secret) }));
  await readTrade(member.client, owner, true);
  succeeded(await setOrganizationMfaRequired(platform.client, { organizationId: owner.organizationId, required: false }));
  await readTrade(memberAal1, owner, false);
  succeeded(await setPlatformOrganizationBlocked(platform.client, { organizationId: owner.organizationId, blocked: true }));
  await readTrade(member.client, owner, false);
  await readTrade(platform.client, owner, false);
  succeeded(await setPlatformOrganizationBlocked(platform.client, { organizationId: owner.organizationId, blocked: false }));
  await readTrade(member.client, owner, true);
  await deletedTradeCompanyFixture(owner);
  await readTrade(member.client, owner, false);
  await readTrade(platform.client, owner, false);
});

it("restricts existing statistics and direct financial reads throughout native MFA recovery and releases only a trusted session", async () => {
  const owner = await tradeFixture();
  const enrollment = succeeded(await beginTotpEnrollment(owner.client));
  const completed = succeeded(await completeTotpEnrollment(owner.client, { factorId: enrollment.factorId, code: totp(enrollment.secret) }));
  await readTrade(owner.client, owner, true);
  const oldAal2 = await staleAccessTokenFixture(owner.client);
  const authentication = passwordRecoveryAuthenticationFixture();
  succeeded(await requestPasswordRecovery(anonymousClient(), authentication, owner.email));
  const recovery = anonymousClient();
  succeeded(await verifyPasswordRecovery(recovery, authentication, await recoveryEmailFixture(owner.email)));
  succeeded(await beginBackupRecovery(recovery, { code: completed.recoveryCodes[0] }));
  await readTrade(oldAal2, owner, false);
  await readTrade(recovery, owner, false);
  const bridge = mfaReplacementAuthenticationFixture();
  const replacement = succeeded(await startReplacementEnrollment(recovery, bridge));
  succeeded(await verifyReplacementAuthenticator(recovery, totp(replacement.secret)));
  await readTrade(recovery, owner, false);
  succeeded(await finishBackupRecovery(recovery, bridge, { newPassword: "Trade-recovered-168", confirmation: "Trade-recovered-168" }));
  await readTrade(recovery, owner, true);
  await readTrade(oldAal2, owner, false);
  const fresh = anonymousClient();
  expect((await fresh.auth.signInWithPassword({ email: owner.email, password: "Trade-recovered-168" })).error).toBeNull();
  await readTrade(fresh, owner, false);
  expect((await fresh.auth.mfa.challengeAndVerify({ factorId: replacement.factorId, code: totp(replacement.secret) })).error).toBeNull();
  await readTrade(fresh, owner, true);
});

it("refuses a mismatched Company/Organization pair even when the reader administers both Organizations", async () => {
  const owner = await tradeFixture();
  const foreign = await administratorWithCompany();
  const invitation = succeeded(await generateInvitationLink(foreign.client, { organizationId: foreign.organizationId, companyId: null,
    email: owner.email, role: "administrator", acceptUrl: "http://localhost/invitations/accept" }));
  succeeded(await acceptInvitation(owner.client, invitation.token));
  const observed = await mismatchedTradeTenantFixture(owner.client, { ...owner, foreignOrganizationId: foreign.organizationId }, {
    ...SAMPLE_EXTRACTION, documentNumber: "INVALID-TENANT-PAIR", counterpartyLink: { id: owner.partyId },
  });
  expect(observed.document).toEqual([]);
  expect(observed.versions).toEqual([]);
  expect(observed.statistics).toMatchObject({ total: 1, entries: [{ documentId: owner.documentId, version: 1 }],
    groups: [{ netAmount: "1000.00", vatAmount: "210.00", grossAmount: "1210.00" }] });
  await readTrade(owner.client, owner, true);
});
