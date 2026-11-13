import { succeeded } from "./support/results";
import { describe, expect, it } from "vitest";
import { beginBackupRecovery, finishBackupRecovery, mfaReplacementStatus, startReplacementEnrollment, verifyReplacementAuthenticator } from "@/application/mfa-replacement";
import { expireAfterNativeMfaVerificationFixture, expireMfaMaintenanceFixture, delayedNativeEnrollmentFixture, expireRecoverySessionFixture, freshEmailRecoveryFixture, mfaReplacementAuthenticationFixture, staleAccessTokenFixture } from "./support/mfa-replacement";
import { beginTotpEnrollment, completeTotpEnrollment, disenrollMfa, mfaPolicy, mfaStatus, setOrganizationMfaRequired, verifyRecoveryCode } from "@/application/mfa";
import { administratorWithCompany } from "./support/fixtures";
import { anonymousClient } from "./support/clients";
import { totp } from "./support/totp";
import { passwordRecoveryAuthenticationFixture, recoveryEmailFixture } from "./support/password-recovery";
import { requestPasswordRecovery, verifyPasswordRecovery } from "@/application/password-recovery";
import { listMyCompanies } from "@/application/companies";
import { systemClient } from "./support/worker";
import { listAuditEvents } from "@/application/audit";
import { listMemberships } from "@/application/memberships";
import { defineSourceDocuments, getSourceFile, readSourceFile, sourceFileObjectPath } from "@/application/source-files";
import { uploadSourceFile } from "./support/source-upload";
import { generateVatReport, getVatReport } from "@/application/vat-reports";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { fixtureFile } from "./support/files";
import type { AppClient } from "@/application/client";

async function recoveryFixture() {
  const user = await administratorWithCompany();
  const enrollment = await beginTotpEnrollment(user.client);
  if (!enrollment.ok) throw new Error(enrollment.error);
  const completed = await completeTotpEnrollment(user.client, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) });
  if (!completed.ok) throw new Error(completed.error);
  const authentication = passwordRecoveryAuthenticationFixture();
  await requestPasswordRecovery(anonymousClient(), authentication, user.email);
  const email = await recoveryEmailFixture(user.email);
  const recovery = anonymousClient();
  const verified = await verifyPasswordRecovery(recovery, authentication, email);
  if (!verified.ok) throw new Error(verified.error);
  return { user, recovery, email, codes: completed.value.recoveryCodes, enrollment: enrollment.value };
}

describe("backup MFA recovery", () => {
  it("refuses expired authenticator setup before native verification and preserves the working session", async () => {
    const fixture = await recoveryFixture();
    expect((await beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] })).ok).toBe(true);
    const bridge = mfaReplacementAuthenticationFixture();
    const replacement = await startReplacementEnrollment(fixture.recovery, bridge);
    if (!replacement.ok) throw new Error(replacement.error);
    expect((await verifyReplacementAuthenticator(fixture.recovery, totp(replacement.value.secret))).ok).toBe(true);
    expect((await finishBackupRecovery(fixture.recovery, bridge, { newPassword: "Maintenance-recovered-168", confirmation: "Maintenance-recovered-168" })).ok).toBe(true);
    const next = await beginTotpEnrollment(fixture.recovery);
    if (!next.ok) throw new Error(next.error);
    await expireMfaMaintenanceFixture(fixture.recovery);
    expect(await completeTotpEnrollment(fixture.recovery, { factorId: next.value.factorId, code: totp(next.value.secret) }))
      .toEqual({ ok: false, error: "mfa_setup_expired" });
    expect(await listMyCompanies(fixture.recovery)).toHaveLength(1);
    expect((await fixture.recovery.auth.mfa.listFactors()).data?.all.find(factor => factor.id === next.value.factorId)?.status).toBe("unverified");
    const retried = await beginTotpEnrollment(fixture.recovery);
    if (!retried.ok) throw new Error(retried.error);
    const deadlineCrossing = await expireAfterNativeMfaVerificationFixture(fixture.recovery);
    expect((await completeTotpEnrollment(deadlineCrossing, { factorId: retried.value.factorId, code: totp(retried.value.secret) })).ok).toBe(true);
    expect(await listMyCompanies(deadlineCrossing)).toHaveLength(1);
  });

  it("removes the current trusted factor and reauthenticates a remaining legitimate authenticator without email recovery", async () => {
    const fixture = await recoveryFixture();
    expect((await beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] })).ok).toBe(true);
    const bridge = mfaReplacementAuthenticationFixture();
    const replacement = await startReplacementEnrollment(fixture.recovery, bridge);
    if (!replacement.ok) throw new Error(replacement.error);
    expect((await verifyReplacementAuthenticator(fixture.recovery, totp(replacement.value.secret))).ok).toBe(true);
    expect((await finishBackupRecovery(fixture.recovery, bridge, { newPassword: "Multifactor-maintenance-168", confirmation: "Multifactor-maintenance-168" })).ok).toBe(true);
    const next = await beginTotpEnrollment(fixture.recovery);
    if (!next.ok) throw new Error(next.error);
    expect((await completeTotpEnrollment(fixture.recovery, { factorId: next.value.factorId, code: totp(next.value.secret) })).ok).toBe(true);
    expect(await disenrollMfa(fixture.recovery, next.value.factorId)).toEqual({ ok: true, value: null });
    expect(succeeded(await mfaReplacementStatus(fixture.recovery))).toMatchObject({ pending: false, needsRecovery: false, factorId: replacement.value.factorId });
    expect(await listMyCompanies(fixture.recovery)).toEqual([]);
    expect((await fixture.recovery.auth.mfa.challengeAndVerify({ factorId: replacement.value.factorId, code: totp(replacement.value.secret) })).error).toBeNull();
    expect(await listMyCompanies(fixture.recovery)).toHaveLength(1);
  });

  it("consumes a prepared legacy code once and restricts every session without claiming native elevation", async () => {
    const fixture = await recoveryFixture();
    expect(await listMyCompanies(fixture.user.client)).toHaveLength(1);
    const begun = await beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] });
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(begun.error);
    expect(begun.value.continuationToken).toMatch(/^[a-f0-9]{64}$/);
    expect(succeeded(await mfaReplacementStatus(fixture.recovery))).toMatchObject({ pending: true, authorized: true, factorId: null });
    expect(await listMyCompanies(fixture.user.client)).toEqual([]);
    expect(await listMyCompanies(fixture.recovery)).toEqual([]);
    expect((succeeded(await mfaStatus(fixture.recovery))).currentLevel).toBe("aal1");
    expect((succeeded(await mfaStatus(fixture.recovery))).recoveryCodesRemaining).toBe(9);
    expect(await beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] })).toEqual({ ok: false, error: "invalid_mfa_code" });
    expect(await verifyRecoveryCode(fixture.user.client, fixture.codes[1])).toEqual({ ok: false, error: "email_recovery_required" });
    expect((succeeded(await mfaStatus(fixture.recovery))).recoveryCodesRemaining).toBe(9);
  });

  it("restores actual TOTP, changes the native password, preserves remaining prepared codes and only then releases data", async () => {
    const fixture = await recoveryFixture();
    const begun = await beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] });
    if (!begun.ok) throw new Error(begun.error);
    const authentication = mfaReplacementAuthenticationFixture();
    const enrollment = await startReplacementEnrollment(fixture.recovery, authentication);
    expect(enrollment.ok).toBe(true);
    if (!enrollment.ok) throw new Error(enrollment.error);
    expect(enrollment.value.factorId).not.toBe(fixture.enrollment.factorId);
    expect(await listMyCompanies(fixture.recovery)).toEqual([]);
    expect(await verifyReplacementAuthenticator(fixture.recovery, totp(enrollment.value.secret))).toEqual({ ok: true, value: null });
    expect((succeeded(await mfaStatus(fixture.recovery))).currentLevel).toBe("aal2");
    expect(await listMyCompanies(fixture.recovery)).toEqual([]);
    expect(await finishBackupRecovery(fixture.recovery, authentication, { newPassword: "Restored-password-168", confirmation: "Restored-password-168" }))
      .toEqual({ ok: true, value: null });
    expect(succeeded(await mfaReplacementStatus(fixture.recovery))).toMatchObject({ pending: false });
    expect(await listMyCompanies(fixture.recovery)).toHaveLength(1);
    expect((succeeded(await mfaStatus(fixture.recovery))).recoveryCodesRemaining).toBe(9);
    expect((await fixture.user.client.auth.refreshSession()).error).not.toBeNull();
    const fresh = anonymousClient();
    expect((await fresh.auth.signInWithPassword({ email: fixture.user.email, password: "Restored-password-168" })).error).toBeNull();
    expect(await listMyCompanies(fresh)).toEqual([]);
    expect(await verifyReplacementAuthenticator(fresh, totp(enrollment.value.secret))).toEqual({ ok: false, error: "mfa_recovery_required" });
    expect((await fresh.auth.mfa.challengeAndVerify({ factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) })).error).toBeNull();
    expect(await listMyCompanies(fresh)).toHaveLength(1);
    const maintained = await beginTotpEnrollment(fresh);
    if (!maintained.ok) throw new Error(maintained.error);
    expect((await completeTotpEnrollment(fresh, { factorId: maintained.value.factorId, code: totp(maintained.value.secret) })).ok).toBe(true);
    expect(await listMyCompanies(fresh)).toHaveLength(1);
    expect(await disenrollMfa(fresh, enrollment.value.factorId)).toEqual({ ok: true, value: null });
    expect(await disenrollMfa(fresh, maintained.value.factorId)).toEqual({ ok: true, value: null });
    expect(await listMyCompanies(fresh)).toHaveLength(1);
  });

  it("denies a competing email-only session that enrolls its own factor during the native removal gap, before and after legitimate completion", async () => {
    const fixture = await recoveryFixture();
    const originalBytes = fixtureFile("receipt.png");
    const uploaded = await uploadSourceFile(fixture.user.client, { async send() {} }, { companyId: fixture.user.companyId, fileName: "receipt.png", bytes: originalBytes });
    if (!uploaded.ok) throw new Error(uploaded.error);
    const source = { companyId: fixture.user.companyId, sourceFileId: uploaded.value.id, ranges: [{ firstPage: 1, lastPage: 1 }] };
    const members = { organizationId: fixture.user.organizationId, companyId: null };
    const report = { companyId: fixture.user.companyId, period: "2026-10" };
    expect((await generateVatReport(fixture.user.client, report)).ok).toBe(true);
    expect(await listMemberships(fixture.user.client, members)).toHaveLength(1);
    const storedReport = await getVatReport(fixture.user.client, report.companyId, report.period);
    expect(storedReport).not.toBeNull();
    async function restrictedSurfaces(actor: AppClient) {
      expect(await listMemberships(actor, members)).toEqual([]);
      expect((await actor.rpc("list_active_memberships", { target_organization_id: members.organizationId, target_company_id: null as unknown as string })).data).toEqual([]);
      expect(await getSourceFile(actor, source.companyId, source.sourceFileId)).toBeNull();
      expect(await readSourceFile(actor, source.companyId, source.sourceFileId)).toBeNull();
      const bucket = actor.storage.from("source-files");
      const objectPath = sourceFileObjectPath(source.companyId, source.sourceFileId);
      expect((await bucket.download(objectPath)).data).toBeNull();
      expect((await bucket.createSignedUrl(objectPath, 60)).data).toBeNull();
      expect((await bucket.list(source.companyId)).data).toEqual([]);
      expect(await getVatReport(actor, report.companyId, report.period)).toBeNull();
      expect(await getReportingPeriodReadiness(actor, report)).toEqual({ ok: false, error: "forbidden" });
      expect(await defineSourceDocuments(actor, source)).toEqual({ ok: false, error: "forbidden" });
      expect((await actor.rpc("define_source_documents", { target_source_file_id: source.sourceFileId, document_ranges: source.ranges })).error?.code).toBe("42501");
    }
    const oldAal2 = await staleAccessTokenFixture(fixture.user.client);
    const begun = await beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] });
    if (!begun.ok) throw new Error(begun.error);
    const authentication = mfaReplacementAuthenticationFixture();
    const original = await startReplacementEnrollment(fixture.recovery, authentication);
    if (!original.ok) throw new Error(original.error);
    const gap = await freshEmailRecoveryFixture(fixture.user.email, fixture.email.requestToken);
    const rogue = await gap.client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Competing email factor" });
    if (rogue.error) throw rogue.error;
    expect((await gap.client.auth.mfa.challengeAndVerify({ factorId: rogue.data.id, code: totp(rogue.data.totp.secret) })).error).toBeNull();
    const gapAal2 = await staleAccessTokenFixture(gap.client);
    expect(succeeded(await mfaReplacementStatus(gap.client))).toMatchObject({ pending: true, authorized: false });
    for (const actor of [oldAal2, gapAal2]) {
      expect(await listMyCompanies(actor)).toEqual([]);
      expect((await actor.from("membership").select("id").eq("organization_id", fixture.user.organizationId)).data).toEqual([]);
      await restrictedSurfaces(actor);
    }
    expect((await gap.client.rpc("claim_mfa_replacement_operation", { operation: "finish" })).error?.hint).toBe("email_recovery_required");
    expect((await gap.client.rpc("complete_mfa_replacement")).error).not.toBeNull();
    expect((await gap.client.rpc("finish_mfa_enrollment")).error?.code).toBe("42501");
    expect((await gap.client.rpc("claim_mfa_maintenance", { target_factor_id: rogue.data.id })).error?.code).toBe("42501");
    expect(await beginBackupRecovery(gap.client, { code: fixture.codes[0] })).toEqual({ ok: false, error: "invalid_mfa_code" });
    const legitimate = await freshEmailRecoveryFixture(fixture.user.email, gap.message.requestToken);
    const resumed = await beginBackupRecovery(legitimate.client, { continuationToken: begun.value.continuationToken });
    if (!resumed.ok) throw new Error(resumed.error);
    expect(resumed.value.continuationToken).not.toBe(begun.value.continuationToken);
    const replacement = await startReplacementEnrollment(legitimate.client, authentication);
    if (!replacement.ok) throw new Error(replacement.error);
    expect(await verifyReplacementAuthenticator(legitimate.client, totp(replacement.value.secret))).toEqual({ ok: true, value: null });
    expect(await listMyCompanies(legitimate.client)).toEqual([]);
    await restrictedSurfaces(legitimate.client);
    expect(await finishBackupRecovery(legitimate.client, authentication, { newPassword: "Safe-replacement-password-168", confirmation: "Safe-replacement-password-168" }))
      .toEqual({ ok: true, value: null });
    expect(await listMyCompanies(legitimate.client)).toHaveLength(1);
    expect(await listMemberships(legitimate.client, members)).toHaveLength(1);
    expect((await readSourceFile(legitimate.client, source.companyId, source.sourceFileId))?.bytes).toEqual(originalBytes);
    expect(await getVatReport(legitimate.client, report.companyId, report.period)).toEqual(storedReport);
    expect((await getReportingPeriodReadiness(legitimate.client, report)).ok).toBe(true);
    for (const actor of [oldAal2, gapAal2]) {
      expect(await listMyCompanies(actor)).toEqual([]);
      await restrictedSurfaces(actor);
    }
    expect((await defineSourceDocuments(legitimate.client, source)).ok).toBe(true);
    expect((await gap.client.auth.refreshSession()).error).not.toBeNull();
  });

  it("fails closed on factor-removal and native logout failures, then retries without consuming another code or losing the changed password", async () => {
    const fixture = await recoveryFixture();
    const begun = await beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] });
    if (!begun.ok) throw new Error(begun.error);
    let failDelete = true;
    let failLogout = true;
    const authentication = mfaReplacementAuthenticationFixture(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (failDelete && init?.method === "DELETE" && url.includes("/auth/v1/admin/users/") && url.includes("/factors/")) {
        return new Response(JSON.stringify({ code: "unexpected_failure", msg: "Temporary native failure" }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      if (failLogout && url.endsWith("/auth/v1/logout?scope=others")) {
        return new Response(JSON.stringify({ code: "bad_jwt", msg: "Native logout refused" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      return fetch(input, init);
    });
    expect(await startReplacementEnrollment(fixture.recovery, authentication)).toEqual({ ok: false, error: "auth_unavailable" });
    expect((await fixture.recovery.auth.mfa.listFactors()).data?.totp.map(factor => factor.id)).toContain(fixture.enrollment.factorId);
    expect(await listMyCompanies(fixture.user.client)).toEqual([]);
    failDelete = false;
    const enrollment = await startReplacementEnrollment(fixture.recovery, authentication);
    if (!enrollment.ok) throw new Error(enrollment.error);
    expect(await verifyReplacementAuthenticator(fixture.recovery, totp(enrollment.value.secret))).toEqual({ ok: true, value: null });
    const password = { newPassword: "Retry-restored-password-168", confirmation: "Retry-restored-password-168" };
    expect(await finishBackupRecovery(fixture.recovery, authentication, password)).toEqual({ ok: false, error: "mfa_recovery_failed" });
    expect(succeeded(await mfaReplacementStatus(fixture.recovery))).toMatchObject({ pending: true, authorized: true, passwordUpdated: true, completionReady: false });
    expect(await listMyCompanies(fixture.recovery)).toEqual([]);
    expect((await fixture.recovery.auth.refreshSession()).error).toBeNull();
    failLogout = false;
    expect(await finishBackupRecovery(fixture.recovery, authentication, { newPassword: "", confirmation: "" })).toEqual({ ok: true, value: null });
    expect(await listMyCompanies(fixture.recovery)).toHaveLength(1);
    expect((succeeded(await mfaStatus(fixture.recovery))).recoveryCodesRemaining).toBe(9);
  });

  it("keeps restriction after email-intent expiry and requires legitimate continuation or a fresh unused backup proof to resume", async () => {
    const fixture = await recoveryFixture();
    const begun = await beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] });
    if (!begun.ok) throw new Error(begun.error);
    await expireRecoverySessionFixture(fixture.recovery);
    expect(succeeded(await mfaReplacementStatus(fixture.recovery))).toMatchObject({ pending: true, authorized: false });
    expect(await listMyCompanies(fixture.user.client)).toEqual([]);
    expect(await beginBackupRecovery(fixture.recovery, { continuationToken: begun.value.continuationToken }))
      .toEqual({ ok: false, error: "email_recovery_required" });
    const fresh = await freshEmailRecoveryFixture(fixture.user.email, fixture.email.requestToken);
    expect(await beginBackupRecovery(fresh.client, { continuationToken: "wrong" })).toEqual({ ok: false, error: "invalid_mfa_code" });
    expect(succeeded(await mfaReplacementStatus(fresh.client))).toMatchObject({ pending: true, authorized: false });
    expect((await beginBackupRecovery(fresh.client, { continuationToken: begun.value.continuationToken })).ok).toBe(true);
    const another = await freshEmailRecoveryFixture(fixture.user.email, fresh.message.requestToken);
    expect(await beginBackupRecovery(another.client, { code: fixture.codes[0] })).toEqual({ ok: false, error: "invalid_mfa_code" });
    expect((await beginBackupRecovery(another.client, { code: fixture.codes[1] })).ok).toBe(true);
    expect((succeeded(await mfaStatus(another.client))).recoveryCodesRemaining).toBe(8);
    expect(succeeded(await mfaReplacementStatus(fresh.client))).toMatchObject({ pending: true, authorized: false });
  });

  it("rejects an untrusted factor whose already-authenticated native enrollment completes after recovery cleanup", async () => {
    const fixture = await recoveryFixture();
    const begun = await beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] });
    if (!begun.ok) throw new Error(begun.error);
    const authentication = mfaReplacementAuthenticationFixture();
    if (!(await startReplacementEnrollment(fixture.recovery, authentication)).ok) throw new Error("Initial replacement setup failed");
    const gap = await freshEmailRecoveryFixture(fixture.user.email, fixture.email.requestToken);
    const rogue = await gap.client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Early competing factor" });
    if (rogue.error) throw rogue.error;
    expect((await gap.client.auth.mfa.challengeAndVerify({ factorId: rogue.data.id, code: totp(rogue.data.totp.secret) })).error).toBeNull();
    const gate = await delayedNativeEnrollmentFixture(fixture.user.userId);
    const delayed = gap.client.auth.mfa.enroll({ factorType: "totp", friendlyName: gate.friendlyName });
    try {
      await gate.waitUntilBlocked();
      const legitimate = await freshEmailRecoveryFixture(fixture.user.email, gap.message.requestToken);
      const resumed = await beginBackupRecovery(legitimate.client, { continuationToken: begun.value.continuationToken });
      if (!resumed.ok) throw new Error(resumed.error);
      const replacement = await startReplacementEnrollment(legitimate.client, authentication);
      if (!replacement.ok) throw new Error(replacement.error);
      expect(await verifyReplacementAuthenticator(legitimate.client, totp(replacement.value.secret))).toEqual({ ok: true, value: null });
      expect(await finishBackupRecovery(legitimate.client, authentication, { newPassword: "Late-factor-safe-password-168", confirmation: "Late-factor-safe-password-168" }))
        .toEqual({ ok: true, value: null });
      await gate.release();
      const late = await delayed;
      if (late.error) throw late.error;
      const after = await freshEmailRecoveryFixture(fixture.user.email, legitimate.message.requestToken);
      expect((await after.client.auth.mfa.challengeAndVerify({ factorId: late.data.id, code: totp(late.data.totp.secret) })).error).toBeNull();
      expect((succeeded(await mfaStatus(after.client))).currentLevel).toBe("aal2");
      expect(await listMyCompanies(after.client)).toEqual([]);
      expect((await after.client.rpc("authorize_mfa_maintenance", { operation: "enroll" })).error).not.toBeNull();
      expect((await after.client.rpc("finish_mfa_enrollment")).error).not.toBeNull();
      expect((await after.client.rpc("claim_mfa_maintenance", { target_factor_id: late.data.id })).error?.code).toBe("42501");
      expect(await listMyCompanies(legitimate.client)).toHaveLength(1);
    } finally {
      await gate.release();
      await delayed;
      await gate.dispose();
    }
  });

  it("rejects anonymous, other-User and service-role bypasses of the scoped claims", async () => {
    const fixture = await recoveryFixture();
    expect(await beginBackupRecovery(fixture.user.client, { code: fixture.codes[0] })).toEqual({ ok: false, error: "email_recovery_required" });
    const begun = await beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] });
    if (!begun.ok) throw new Error(begun.error);
    const operation = await fixture.recovery.rpc("claim_mfa_replacement_operation", { operation: "enroll" });
    if (operation.error) throw operation.error;
    const other = await administratorWithCompany();
    for (const client of [anonymousClient(), other.client]) {
      expect((await client.rpc("mfa_replacement_authority", { recovery_operation_id: operation.data })).error?.code).toBe("42501");
      expect((await client.rpc("confirm_mfa_replacement_native_finish", { recovery_operation_id: operation.data })).error?.code).toBe("42501");
      expect((await client.rpc("bind_mfa_replacement_factor", { recovery_operation_id: operation.data, enrolled_factor_id: fixture.enrollment.factorId })).error?.code).toBe("42501");
    }
    expect((await other.client.rpc("release_mfa_replacement_operation", { recovery_operation_id: operation.data })).error).toBeNull();
    expect(succeeded(await mfaReplacementStatus(other.client))).toMatchObject({ pending: false, authorized: false });
    expect((await other.client.schema("private" as "public").from("mfa_replacement" as "membership").select("*")).error?.code).toBe("PGRST106");
    expect((await systemClient().rpc("verify_mfa_recovery_code", { input_code: fixture.codes[1] })).error?.code).toBe("42501");
    expect((await systemClient().rpc("begin_mfa_replacement", { input_code: fixture.codes[1] })).error?.code).toBe("42501");
    expect((await fixture.recovery.rpc("mfa_replacement_authority", { recovery_operation_id: operation.data })).error?.code).toBe("42501");
    expect(succeeded(await mfaReplacementStatus(fixture.recovery))).toMatchObject({ pending: true, authorized: true });
    expect((await fixture.recovery.rpc("release_mfa_replacement_operation", { recovery_operation_id: operation.data })).error).toBeNull();
  });

  it("consumes a prepared code only once under concurrent requests", async () => {
    const fixture = await recoveryFixture();
    const results = await Promise.all([
      beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] }),
      beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] }),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: "invalid_mfa_code" }]);
    expect((succeeded(await mfaStatus(fixture.recovery))).recoveryCodesRemaining).toBe(9);
  });

  it("preserves mandatory Organization and SuperAdmin MFA and records only the real User with empty audit payloads", async () => {
    const fixture = await recoveryFixture();
    expect((await systemClient().from("platform_user").insert({ user_id: fixture.user.userId, role: "super_admin" })).error).toBeNull();
    expect(await setOrganizationMfaRequired(fixture.user.client, { organizationId: fixture.user.organizationId, required: true })).toEqual({ ok: true, value: null });
    const begun = await beginBackupRecovery(fixture.recovery, { code: fixture.codes[0] });
    if (!begun.ok) throw new Error(begun.error);
    expect((await fixture.recovery.rpc("current_user_can_administrate_platform")).data).toBe(false);
    expect(await setOrganizationMfaRequired(fixture.recovery, { organizationId: fixture.user.organizationId, required: false })).toEqual({ ok: false, error: "forbidden" });
    const authentication = mfaReplacementAuthenticationFixture();
    const enrollment = await startReplacementEnrollment(fixture.recovery, authentication);
    if (!enrollment.ok) throw new Error(enrollment.error);
    expect(await verifyReplacementAuthenticator(fixture.recovery, totp(enrollment.value.secret))).toEqual({ ok: true, value: null });
    expect((await fixture.recovery.rpc("current_user_can_administrate_platform")).data).toBe(false);
    expect(await finishBackupRecovery(fixture.recovery, authentication, { newPassword: "Mandatory-recovery-password-168", confirmation: "Mandatory-recovery-password-168" }))
      .toEqual({ ok: true, value: null });
    expect(succeeded(await mfaPolicy(fixture.recovery))).toEqual({ required: true, enrolled: true, satisfied: true });
    expect((await fixture.recovery.rpc("current_user_can_administrate_platform")).data).toBe(true);
    const events = (await listAuditEvents(fixture.recovery, fixture.user.organizationId)).filter(event => ["user.mfa_recovery_started", "user.mfa_recovered"].includes(event.action));
    expect(events.map(event => ({ action: event.action, actor: event.actorUserId, payload: event.payload }))).toEqual([
      { action: "user.mfa_recovery_started", actor: fixture.user.userId, payload: {} },
      { action: "user.mfa_recovered", actor: fixture.user.userId, payload: {} },
    ]);
    const serialized = JSON.stringify(events);
    for (const secret of [fixture.user.email, fixture.codes[0], begun.value.continuationToken, enrollment.value.secret, "Mandatory-recovery-password-168"]) expect(serialized).not.toContain(secret);
    expect(await disenrollMfa(fixture.recovery, enrollment.value.factorId)).toEqual({ ok: true, value: null });
    expect(succeeded(await mfaPolicy(fixture.recovery))).toEqual({ required: true, enrolled: false, satisfied: false });
    expect((await fixture.recovery.rpc("current_user_can_administrate_platform")).data).toBe(false);
    expect(await listMyCompanies(fixture.recovery)).toEqual([]);
  });
});
