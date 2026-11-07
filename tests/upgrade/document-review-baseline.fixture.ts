import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION, fakeAiProvider } from "@/ai/fake";
import { setCurrentReportingYear } from "@/application/companies";
import { createManualDocument, correctDocument, approveDocument, listDocuments, updateDocumentReporting } from "@/application/documents";
import { uploadSourceFile } from "@/application/source-files";
import { generateVatReport, finalizeVatReport } from "@/application/vat-reports";
import { exportFinalVatReport } from "@/application/epo-export";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { fakeExchangeRates } from "@/cnb/fake";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany, assignAiConfigurationFixture } from "../support/fixtures";
import { testWorker } from "../support/worker";
import { fixtureFile } from "../support/files";
import { captureLegacy, type LegacyCompany, type UpgradeManifest } from "./document-review-capture";

it("creates genuine pre-feature AI/manual Versions, finalized archives and an RC deferral through the old public application", async () => {
  const manifest: UpgradeManifest = { companies: [] };
  for (const reverseCharge of [false, true]) {
    const owner = await administratorWithCompany(`Upgrade ${reverseCharge ? "RC" : "ordinary"}`);
    expect(await setCurrentReportingYear(owner.client, { companyId: owner.companyId, year: 2025, filingFrequency: "monthly" }))
      .toEqual({ ok: true, value: null });
    const payload = { ...SAMPLE_EXTRACTION, documentNumber: reverseCharge ? "LEGACY-RC" : "LEGACY-AI",
      issueDate: "2025-10-10", taxPointDate: "2025-10-15", dueDate: "2025-10-30",
      ...(reverseCharge ? { proposedVatRegime: "domestic_reverse_charge" as const, reverseChargeCode: "4" } : {}) };
    let documentId: string;
    let sourceFileId: string | undefined;
    if (reverseCharge) {
      const created = await createManualDocument(owner.client, { companyId: owner.companyId, payload }, fakeExchangeRates(), fakeVatPayerRegistry());
      if (!created.ok) throw new Error(created.error);
      documentId = created.value.id;
      expect(await updateDocumentReporting(owner.client, { companyId: owner.companyId, documentId, claimedReportingPeriod: "2025-12" }))
        .toEqual({ ok: true, value: null });
    } else {
      const worker = testWorker(fakeAiProvider({ extract: () => payload }));
      await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai });
      const uploaded = await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
      if (!uploaded.ok) throw new Error(uploaded.error);
      sourceFileId = uploaded.value.id;
      expect(await worker.runJobs()).toEqual([]);
      expect(worker.queued).toEqual([]);
      expect(worker.delayed).toEqual([]);
      const [document] = await listDocuments(owner.client, owner.companyId, sourceFileId);
      documentId = document.id;
      expect(await correctDocument(owner.client, { companyId: owner.companyId, documentId, basedOnVersion: 1,
        payload: { ...payload, documentNumber: "LEGACY-CORRECTED" } }, fakeExchangeRates(), fakeVatPayerRegistry()))
        .toEqual({ ok: true, value: { version: 2 } });
    }
    expect(await approveDocument(owner.client, { companyId: owner.companyId, documentId, version: reverseCharge ? 1 : 2 }))
      .toEqual({ ok: true, value: null });
    const period = reverseCharge ? "2025-12" : "2025-10";
    expect(await saveCompanyFilingDefaults(owner.client, { companyId: owner.companyId, taxOffice: "451", territorialOffice: "2003",
      economicActivity: "621000", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
      email: "upgrade@example.test", phone: "+420123456789", epoAddressOverride: null })).toEqual({ ok: true, value: null });
    expect(await generateVatReport(owner.client, { companyId: owner.companyId, period })).toMatchObject({ ok: true });
    expect(await finalizeVatReport(owner.client, { companyId: owner.companyId, period, confirmed: true })).toEqual({ ok: true, value: null });
    for (const format of ["dphdp3", "dphkh1"]) {
      const exported = await exportFinalVatReport(owner.client, { companyId: owner.companyId, period, format, details: { preparedOn: "2026-11-07" } });
      if (!exported.ok) throw new Error(exported.error);
      expect(exported.value.bytes.byteLength).toBeGreaterThan(0);
    }
    const documentIds = [documentId];
    if (!reverseCharge) {
      const manual = await createManualDocument(owner.client, { companyId: owner.companyId,
        payload: { ...payload, documentNumber: "LEGACY-SOURCE-INDEPENDENT", taxPointDate: "2025-12-15" } }, fakeExchangeRates(), fakeVatPayerRegistry());
      if (!manual.ok) throw new Error(manual.error);
      documentIds.push(manual.value.id);
    }
    const identity: LegacyCompany = { companyId: owner.companyId, userId: owner.userId, email: owner.email,
      documentIds, period, ...(sourceFileId ? { sourceFileId } : {}) };
    const before = await captureLegacy(owner.client, identity);
    expect(before.lock).not.toBeNull();
    expect(before.artifacts).toHaveLength(2);
    manifest.companies.push({ identity, before });
  }
  await writeFile(process.env.IVAT_UPGRADE_MANIFEST!, JSON.stringify(manifest), { mode: 0o600 });
});
