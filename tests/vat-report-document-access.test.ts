import { Client } from "pg";
import { describe, expect, inject, it } from "vitest";
import { beginTotpEnrollment, completeTotpEnrollment, setOrganizationMfaRequired } from "@/application/mfa";
import { beginBackupRecovery } from "@/application/mfa-replacement";
import { requestPasswordRecovery, verifyPasswordRecovery } from "@/application/password-recovery";
import { generateVatReport, getVatReport } from "@/application/vat-reports";
import { anonymousClient, provisionedUser } from "./support/clients";
import { companyMember, companyWithManyReportDocuments } from "./support/fixtures";
import { passwordRecoveryAuthenticationFixture, recoveryEmailFixture } from "./support/password-recovery";
import { totp } from "./support/totp";
import { systemClient } from "./support/worker";

describe("report Document authority", () => {
  it("generates the complete report as Company members, the Organization Administrator and a real AAL2 SuperAdmin", async () => {
    const owner = await companyWithManyReportDocuments(1);
    const member = await companyMember(owner);
    const administrator = await companyMember(owner, "administrator");
    const platform = await provisionedUser("Report platform operator");
    const promoted = await systemClient().from("platform_user").insert({ user_id: platform.userId, role: "super_admin" });
    if (promoted.error) throw promoted.error;
    const beforeMfa = await platform.client.rpc("vat_report_documents", { target_company_id: owner.companyId, target_period: "2026-10" });
    expect(beforeMfa.error).toBeNull();
    expect(beforeMfa.data).toEqual([]);
    const enrollment = await beginTotpEnrollment(platform.client);
    if (!enrollment.ok) throw new Error(enrollment.error);
    expect((await completeTotpEnrollment(platform.client, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) })).ok).toBe(true);
    for (const actor of [owner, member, administrator, platform]) {
      expect((await generateVatReport(actor.client, { companyId: owner.companyId, period: "2026-10" })).ok).toBe(true);
      const report = await getVatReport(actor.client, owner.companyId, "2026-10");
      expect(report?.documents.map(document => document.id)).toEqual(owner.documentIds);
      expect(report?.documents.map(document => document.importDate)).toEqual(["2026-10-10"]);
      expect(report?.result.excludedDocuments.map(document => document.reason)).toEqual(["not_approved"]);
    }
  });

  it("hides foreign, missing and null Companies at the direct RPC boundary", async () => {
    const owner = await companyWithManyReportDocuments(1);
    const outsider = await provisionedUser("Report outsider");
    for (const companyId of [owner.companyId, crypto.randomUUID(), null]) {
      const denied = await outsider.client.rpc("vat_report_documents", { target_company_id: companyId as string, target_period: "2026-10" });
      expect(denied.error).toBeNull();
      expect(denied.data).toEqual([]);
    }
  });

  it.each(["blocked Organization", "deleted Company", "required MFA"] as const)("hides the projection for a %s", async (restriction) => {
    const owner = await companyWithManyReportDocuments(1);
    if (restriction === "required MFA") {
      expect(await setOrganizationMfaRequired(owner.client, { organizationId: owner.organizationId, required: true }))
        .toEqual({ ok: true, value: null });
    } else {
      const changed = restriction === "blocked Organization"
        ? await systemClient().from("organization").update({ blocked_at: new Date().toISOString() }).eq("id", owner.organizationId)
        : await systemClient().from("company").update({ deleted_at: new Date().toISOString(), deleted_by: owner.userId }).eq("id", owner.companyId);
      if (changed.error) throw changed.error;
    }
    const denied = await owner.client.rpc("vat_report_documents", { target_company_id: owner.companyId, target_period: "2026-10" });
    expect(denied.error).toBeNull();
    expect(denied.data).toEqual([]);
    expect(await generateVatReport(owner.client, { companyId: owner.companyId, period: "2026-10" }))
      .toEqual({ ok: false, error: "forbidden" });
  });

  it("does not grant anonymous or worker callers execution of the report projection", async () => {
    const owner = await companyWithManyReportDocuments(1);
    for (const actor of [anonymousClient(), systemClient()]) {
      const denied = await actor.rpc("vat_report_documents", { target_company_id: owner.companyId, target_period: "2026-10" });
      expect(denied.error?.code).toBe("42501");
      expect(denied.data).toBeNull();
    }
  });

  it("hides existing report Documents from every session while backup MFA recovery is pending", async () => {
    const owner = await companyWithManyReportDocuments(1);
    const enrollment = await beginTotpEnrollment(owner.client);
    if (!enrollment.ok) throw new Error(enrollment.error);
    const completed = await completeTotpEnrollment(owner.client, { factorId: enrollment.value.factorId, code: totp(enrollment.value.secret) });
    if (!completed.ok) throw new Error(completed.error);
    const scope = { target_company_id: owner.companyId, target_period: "2026-10" };
    expect((await owner.client.rpc("vat_report_documents", scope)).data).toHaveLength(1);
    const authentication = passwordRecoveryAuthenticationFixture();
    expect((await requestPasswordRecovery(anonymousClient(), authentication, owner.email)).ok).toBe(true);
    const recovery = anonymousClient();
    expect((await verifyPasswordRecovery(recovery, authentication, await recoveryEmailFixture(owner.email))).ok).toBe(true);
    expect((await beginBackupRecovery(recovery, { code: completed.value.recoveryCodes[0] })).ok).toBe(true);
    for (const actor of [owner.client, recovery]) {
      const denied = await actor.rpc("vat_report_documents", scope);
      expect(denied.error).toBeNull();
      expect(denied.data).toEqual([]);
    }
  });

  it("ignores a foreign higher Version while its tenant FK is deferred", async () => {
    const owner = await companyWithManyReportDocuments(1);
    const foreign = await companyWithManyReportDocuments(1);
    const baseline = await owner.client.rpc("vat_report_documents", { target_company_id: owner.companyId, target_period: "2026-10" });
    expect(baseline.error).toBeNull();
    expect(baseline.data).toHaveLength(1);
    const { data } = await owner.client.auth.getSession();
    const claims = JSON.parse(Buffer.from(data.session!.access_token.split(".")[1], "base64url").toString());
    const database = new Client({ connectionString: inject("databaseUrl") });
    await database.connect();
    try {
      await database.query("begin");
      await database.query("set constraints public.extraction_version_document_id_company_id_organization_id_fkey deferred");
      // Privileged corruption fixture; rollback never persists the invalid FK.
      const inserted = await database.query(`
        insert into public.extraction_version (
          organization_id, company_id, document_id, version, provider, model, extraction_request_id, payload
        )
        select organization_id, company_id, $1::uuid, 99, provider, model, gen_random_uuid(),
          payload || '{"invoiceNumber":"FOREIGN-REPORT-SECRET"}'::jsonb
        from public.extraction_version where document_id = $2::uuid returning id
      `, [owner.documentIds[0], foreign.documentIds[0]]);
      expect(inserted.rowCount).toBe(1);
      await database.query("set local role authenticated");
      await database.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      const projected = await database.query("select public.vat_report_documents($1::uuid, '2026-10') as documents", [owner.companyId]);
      expect(projected.rows[0].documents).toEqual(baseline.data);
    } finally {
      await database.query("rollback");
      await database.end();
    }
  });
});
