import { readFile } from "node:fs/promises";
import { expect, inject, it } from "vitest";
import { anonymousClient } from "../support/clients";
import { withClaimDate } from "../support/claim-clock";
import { getCompany } from "@/application/companies";
import { listCounterparties } from "@/application/counterparties";
import { getDocumentReview } from "@/application/document-review";
import { approveDocument, correctDocument, returnDocumentToReview, updateDocumentReporting, listExtractionVersions } from "@/application/documents";
import { generateVatReport, unlockReportingPeriod } from "@/application/vat-reports";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { readVatReportArtifact } from "@/application/epo-export";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { captureLegacy, sha256, type UpgradeManifest } from "./document-review-capture";

it("upgrades real legacy Versions and locked archives without invented metadata or AI work, and requires explicit RC resolution", async () => {
  const manifest: UpgradeManifest = JSON.parse(await readFile(process.env.IVAT_UPGRADE_MANIFEST!, "utf8"));
  expect(manifest.companies).toHaveLength(2);
  await withClaimDate(inject("databaseUrl"), "2026-11-07", async () => {
    for (const { identity, before } of manifest.companies) {
      const client = anonymousClient();
      const signedIn = await client.auth.signInWithPassword({ email: identity.email, password: "correct-horse-battery" });
      if (signedIn.error) throw signedIn.error;
      expect(signedIn.data.user!.id).toBe(identity.userId);
      // Capture before any current correction/unlock: new rules must not rewrite history.
      expect(await captureLegacy(client, identity)).toEqual(before);
      expect(await getCompany(client, identity.companyId)).toMatchObject({ automaticApprovalEnabled: false });
      expect((await listCounterparties(client, identity.companyId)).total).toBe(0);
      for (const id of identity.documentIds) {
        const review = await getDocumentReview(client, { companyId: identity.companyId, documentId: id });
        expect(review).not.toBeNull();
        for (const version of review!.versions) {
          expect(version.payload).not.toHaveProperty("partialClaim");
          expect(version.payload).not.toHaveProperty("claimEligibility");
          expect(version.payload).not.toHaveProperty("sourceEvidence");
          expect(version.payload).not.toHaveProperty("counterpartyLink");
          const historical = await getDocumentReview(client, { companyId: identity.companyId, documentId: id, requestedVersion: String(version.version) });
          expect(historical?.shown?.payload).toEqual(version.payload);
        }
        const links = await client.from("extraction_version").select("counterparty_id").eq("document_id", id);
        if (links.error) throw links.error;
        expect(links.data.every(row => row.counterparty_id === null)).toBe(true);
      }
      const target = { companyId: identity.companyId, documentId: identity.documentIds[0] };
      expect(await returnDocumentToReview(client, target)).toEqual({ ok: false, error: "period_locked" });
      const versions = await listExtractionVersions(client, target.companyId, target.documentId);
      expect(await correctDocument(client, { ...target, basedOnVersion: versions.at(-1)!.version,
        payload: { ...versions.at(-1)!.payload, documentNumber: "MUST-NOT-REWRITE-LOCK" } }, undefined, fakeVatPayerRegistry()))
        .toEqual({ ok: false, error: "not_in_review" });
      expect(await captureLegacy(client, identity)).toEqual(before);

      if (identity.period === "2025-12") {
        for (const period of ["2025-10", "2025-12"]) {
          expect(await getReportingPeriodReadiness(client, { companyId: identity.companyId, period }))
            .toMatchObject({ ok: true, value: { ready: false, blockers: [{ documentId: target.documentId, findingCode: "deferred_claim_not_supported" }] } });
          expect(await generateVatReport(client, { companyId: identity.companyId, period }))
            .toEqual({ ok: false, error: "claim_eligibility_unresolved" });
        }
        // Archive download is independent of today's refusal of new preparation.
        for (const artifact of before.artifacts) {
          const saved = await readVatReportArtifact(client, { companyId: identity.companyId, artifactId: artifact.metadata.id });
          expect(Buffer.from(saved!.bytes).toString("base64")).toBe(artifact.base64);
          expect(sha256(saved!.bytes)).toBe(artifact.sha256);
          expect(saved!.artifact).toEqual(artifact.downloadedMetadata);
        }
        expect(await unlockReportingPeriod(client, { companyId: identity.companyId, period: identity.period,
          confirmed: true, reason: "Resolve the explicitly retained legacy RC deferral" })).toEqual({ ok: true, value: null });
        expect(await returnDocumentToReview(client, target)).toEqual({ ok: true, value: null });
        expect(await updateDocumentReporting(client, { ...target, claimedReportingPeriod: null })).toEqual({ ok: true, value: null });
        expect(await approveDocument(client, { ...target, version: 1 })).toEqual({ ok: true, value: null });
        expect(await generateVatReport(client, { companyId: identity.companyId, period: "2025-10" })).toMatchObject({ ok: true });
        const afterResolution = await captureLegacy(client, identity);
        expect(afterResolution.documents[0].storedVersions.slice(0, before.documents[0].storedVersions.length)).toEqual(before.documents[0].storedVersions);
        expect(afterResolution.documents[0].versions.map(version => version.author)).toEqual([
          { kind: "user", userId: identity.userId }, { kind: "user", userId: identity.userId },
        ]);
        expect(afterResolution.documents[0].versions[1].payload.counterpartyLink).toMatchObject({ id: expect.any(String) });
        expect(afterResolution.artifacts).toEqual(before.artifacts);
        expect(afterResolution.report).toEqual(before.report);
        expect(afterResolution.allowance).toEqual(before.allowance);
        expect(afterResolution.lock).toBeNull();
        expect(afterResolution.transitions.map(row => row.action)).toEqual(["vat_report.finalized", "reporting_period.unlocked"]);
        expect(afterResolution.documents[0].document).toMatchObject({ status: "approved", claimedReportingPeriod: null });
      } else {
        expect(before.documents[0].versions.map(version => version.author.kind)).toEqual(["ai", "user"]);
        expect(before.allowance).toMatchObject({ ok: true, value: { used: 1 } });
        expect(before.documents[1].document).toMatchObject({ sourceFileId: null, firstPage: null, lastPage: null, importDate: null });
        expect(before.documents[1].versions).toHaveLength(1);
        expect(before.documents[1].versions[0].author).toEqual({ kind: "user", userId: identity.userId });
      }
      await client.auth.signOut({ scope: "local" });
    }
  });
});
