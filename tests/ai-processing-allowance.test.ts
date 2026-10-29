import { afterEach, describe, expect, it } from "vitest";
import type { AiProvider } from "@/application/ai-provider";
import {
  getCompanyAiProcessingAllowance,
  listPlatformAiProcessingAllowances,
  setCompanyAiProcessingAllowance,
} from "@/application/ai-processing-allowance";
import {
  clearDefaultAiConfiguration,
  createAiConfiguration,
  setDefaultAiConfiguration,
} from "@/application/ai-configurations";
import {
  correctDocument,
  listCompanyDocuments,
  listExtractionVersions,
  reprocessDocument,
} from "@/application/documents";
import { uploadSourceFile } from "@/application/source-files";
import { getCompany } from "@/application/companies";
import { listPlatformAuditEvents } from "@/application/audit";
import { SAMPLE_EXTRACTION, fakeAiProvider } from "@/ai/fake";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { promotedSuperAdministrator } from "./support/platform";
import { testWorker } from "./support/worker";

const defaultsToClear: Awaited<ReturnType<typeof promotedSuperAdministrator>>[] = [];

afterEach(async () => {
  for (const superAdministrator of defaultsToClear.splice(0)) {
    await clearDefaultAiConfiguration(superAdministrator.client);
  }
});

async function companyWithDefaultAi(name: string, allowance = 50) {
  const superAdministrator = await promotedSuperAdministrator(`${name} SuperAdmin`, `allowance-${name}`);
  defaultsToClear.push(superAdministrator);
  const configuration = await createAiConfiguration(superAdministrator.client, {
    label: `${name} ${superAdministrator.userId}`,
    provider: "anthropic",
    splitModel: "allowance-split",
    extractModel: "allowance-extract",
    credential: "allowance-secret",
  });
  if (!configuration.ok) throw new Error(configuration.error);
  const selected = await setDefaultAiConfiguration(superAdministrator.client, configuration.value.id);
  if (!selected.ok) throw new Error(selected.error);
  const company = await administratorWithCompany(name);
  if (allowance !== 50) {
    const changed = await setCompanyAiProcessingAllowance(superAdministrator.client, { async send() {} }, {
      companyId: company.companyId,
      allowance,
    });
    if (!changed.ok) throw new Error(changed.error);
  }
  return { superAdministrator, configurationId: configuration.value.id, company };
}

describe("AI Processing Allowance", () => {
  it("defaults a new Company to 50 and exposes allowance controls only to the right Roles", async () => {
    const { superAdministrator, configurationId, company } = await companyWithDefaultAi("Default allowance");
    const companyAdministrator = await companyMember(company, "administrator");
    const user = await companyMember(company, "user");

    expect(await getCompanyAiProcessingAllowance(companyAdministrator.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 0, allowance: 50, waitingDocuments: 0 },
    });
    expect(await getCompanyAiProcessingAllowance(user.client, company.companyId)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await setCompanyAiProcessingAllowance(company.client, { async send() {} }, {
      companyId: company.companyId,
      allowance: 1,
    })).toEqual({ ok: false, error: "forbidden" });
    expect(await setCompanyAiProcessingAllowance(superAdministrator.client, { async send() {} }, {
      companyId: company.companyId,
      allowance: -1,
    })).toEqual({ ok: false, error: "invalid_allowance" });
    expect(await setCompanyAiProcessingAllowance(superAdministrator.client, { async send() {} }, {
      companyId: company.companyId,
      allowance: null,
    })).toEqual({ ok: true, value: null });
    expect(await getCompanyAiProcessingAllowance(companyAdministrator.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 0, allowance: null, waitingDocuments: 0 },
    });
    expect(await listPlatformAuditEvents(superAdministrator.client)).toContainEqual(expect.objectContaining({
      action: "company.ai_processing_allowance_changed",
      targetType: "company",
      targetId: company.companyId,
      payload: { allowance: null },
    }));

    expect(await listPlatformAiProcessingAllowances(superAdministrator.client)).toEqual({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          companyId: company.companyId,
          companyName: "Novák s.r.o.",
          configurationId,
          used: 0,
          allowance: null,
          waitingDocuments: 0,
        }),
      ]),
    });
    expect(await listPlatformAiProcessingAllowances(company.client)).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("does not call Extraction at zero and shows the explicit allowance-wait state", async () => {
    const { superAdministrator, company } = await companyWithDefaultAi("Zero allowance", 0);
    const fake = fakeAiProvider();
    let extractionCalls = 0;
    const provider: AiProvider = {
      ...fake,
      name: "anthropic",
      async extract(input, context) {
        extractionCalls += 1;
        return fake.extract(input, context);
      },
    };
    const worker = testWorker(provider);
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "zero-allowance.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs()).toEqual([]);
    expect(extractionCalls).toBe(0);
    expect(await listCompanyDocuments(company.client, company.companyId)).toEqual([
      expect.objectContaining({ status: "waiting_for_allowance" }),
    ]);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 0, allowance: 0, waitingDocuments: 1 },
    });

    expect(await setCompanyAiProcessingAllowance(superAdministrator.client, worker.jobs, {
      companyId: company.companyId,
      allowance: null,
    })).toEqual({ ok: true, value: null });
    expect(await worker.runJobs()).toEqual([]);
    expect(extractionCalls).toBe(1);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 1, allowance: null, waitingDocuments: 0 },
    });
  });

  it("uses the final finite unit in page order and resumes waiting Documents after an increase", async () => {
    const { superAdministrator, company } = await companyWithDefaultAi("One unit", 1);
    const provider = { ...fakeAiProvider(), name: "anthropic" };
    const worker = testWorker(provider);
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "two-invoices.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs()).toEqual([]);
    expect(await listCompanyDocuments(company.client, company.companyId)).toEqual([
      expect.objectContaining({ firstPage: 1, status: "needs_review" }),
      expect.objectContaining({ firstPage: 2, status: "waiting_for_allowance" }),
    ]);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 1, allowance: 1, waitingDocuments: 1 },
    });

    expect(await setCompanyAiProcessingAllowance(superAdministrator.client, worker.jobs, {
      companyId: company.companyId,
      allowance: 2,
    })).toEqual({ ok: true, value: null });
    expect(await worker.runJobs()).toEqual([]);
    expect((await listCompanyDocuments(company.client, company.companyId)).map((document) => document.status))
      .toEqual(["needs_review", "needs_review"]);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 2, allowance: 2, waitingDocuments: 0 },
    });
  });

  it("allows only one of two concurrent final Extractions to complete", async () => {
    const { company } = await companyWithDefaultAi("Concurrent final unit", 1);
    const worker = testWorker({ ...fakeAiProvider(), name: "anthropic" });
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "concurrent-final-unit.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await worker.runNextJob();

    expect(await worker.runJobsConcurrently()).toEqual([]);
    const documents = await listCompanyDocuments(company.client, company.companyId);
    expect(documents.filter((document) => document.status === "needs_review")).toHaveLength(1);
    expect(documents.filter((document) => document.status === "waiting_for_allowance")).toHaveLength(1);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 1, allowance: 1, waitingDocuments: 1 },
    });
  });

  it("releases a failed attempt so its retry can consume the unit only after success", async () => {
    const { company } = await companyWithDefaultAi("Failed attempt", 1);
    let failing = true;
    const fake = fakeAiProvider();
    const worker = testWorker({
      ...fake,
      name: "anthropic",
      async extract(input, context) {
        if (failing) throw new Error("provider unavailable");
        return fake.extract(input, context);
      },
    });
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "retry.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs({ final: false })).toEqual([expect.any(Error)]);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 0, allowance: 1, waitingDocuments: 0 },
    });
    const [document] = await listCompanyDocuments(company.client, company.companyId);
    failing = false;
    worker.queued.push({ name: "extract-document", data: { documentId: document.id } });
    expect(await worker.runJobs()).toEqual([]);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 1, allowance: 1, waitingDocuments: 0 },
    });
    const user = await companyMember(company, "user");
    expect(JSON.stringify(await getCompany(user.client, company.companyId))).not.toMatch(
      /anthropic|allowance-extract|allowance-secret/,
    );
    expect(await listExtractionVersions(user.client, company.companyId, document.id)).toEqual([
      expect.objectContaining({ author: { kind: "ai" } }),
    ]);
    expect(JSON.stringify(await listExtractionVersions(user.client, company.companyId, document.id))).not.toMatch(
      /anthropic|allowance-extract|allowance-secret/,
    );
    expect((await user.client.from("company").select("ai_provider").eq("id", company.companyId)).error?.code)
      .toBe("42501");
    expect((await user.client.from("extraction_version").select("provider, model").eq("document_id", document.id))
      .error?.code).toBe("42501");
  });

  it("counts successful re-Extraction but not a User correction", async () => {
    const { company } = await companyWithDefaultAi("Repeated Extraction", 2);
    const worker = testWorker({ ...fakeAiProvider(), name: "anthropic" });
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "repeat.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect(await worker.runJobs()).toEqual([]);
    const [document] = await listCompanyDocuments(company.client, company.companyId);

    expect(await correctDocument(company.client, {
      companyId: company.companyId,
      documentId: document.id,
      basedOnVersion: 1,
      payload: { ...SAMPLE_EXTRACTION, documentNumber: "USER-CORRECTION" },
    })).toEqual({ ok: true, value: { version: 2 } });
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 1, allowance: 2, waitingDocuments: 0 },
    });

    expect(await reprocessDocument(company.client, worker.jobs, {
      companyId: company.companyId,
      documentId: document.id,
    })).toEqual({ ok: true, value: null });
    expect(await worker.runJobs()).toEqual([]);
    expect((await listExtractionVersions(company.client, company.companyId, document.id)).map((version) =>
      version.author.kind
    )).toEqual(["ai", "user", "ai"]);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 2, allowance: 2, waitingDocuments: 0 },
    });
  });
});
