import { Client as DatabaseClient } from "pg";
import { afterEach, describe, expect, inject, it } from "vitest";
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
  updateAiConfiguration,
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
import { listPlatformOperationalProblems } from "@/application/operational-problems";
import { SAMPLE_EXTRACTION, fakeAiProvider } from "@/ai/fake";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { promotedSuperAdministrator } from "./support/platform";
import { systemClient, testWorker } from "./support/worker";
import cs from "../messages/cs.json";

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
    expect((await company.client.rpc("restore_ai_processing_allowance_wait", {
      target_company_id: company.companyId,
      target_document_ids: [crypto.randomUUID()],
    })).error?.code).toBe("42501");
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
    const user = await companyMember(company, "user");
    expect(await listCompanyDocuments(user.client, company.companyId)).toEqual([
      expect.objectContaining({ status: "waiting_for_allowance" }),
    ]);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 0, allowance: 0, waitingDocuments: 1 },
    });
    const beforeRemediation = await listPlatformOperationalProblems(superAdministrator.client);
    expect(beforeRemediation).toEqual({ ok: true, value: expect.any(Array) });
    if (!beforeRemediation.ok) throw new Error(beforeRemediation.error);
    expect(beforeRemediation.value).toContainEqual(expect.objectContaining({
      kind: "allowance_exhausted",
      companies: expect.arrayContaining([expect.objectContaining({ id: company.companyId })]),
    }));

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
    const afterRemediation = await listPlatformOperationalProblems(superAdministrator.client);
    if (!afterRemediation.ok) throw new Error(afterRemediation.error);
    expect(afterRemediation.value.some((problem) => (
      problem.kind === "allowance_exhausted"
      && problem.companies.some(({ id }) => id === company.companyId)
    ))).toBe(false);
  });

  it("exhausts allowance before resolving an unavailable provider and shows the exact Czech message", async () => {
    const { company } = await companyWithDefaultAi("Zero before provider", 0);
    const splittingWorker = testWorker({ ...fakeAiProvider(), name: "anthropic" });
    const uploaded = await uploadSourceFile(company.client, splittingWorker.jobs, {
      companyId: company.companyId,
      fileName: "zero-before-provider.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await splittingWorker.runNextJob();
    splittingWorker.queued.splice(0);

    const unavailableWorker = testWorker([]);
    const [document] = await listCompanyDocuments(company.client, company.companyId);
    unavailableWorker.queued.push({ name: "extract-document", data: { documentId: document.id } });

    expect(await unavailableWorker.runJobs()).toEqual([]);
    expect((await listCompanyDocuments(company.client, company.companyId))[0].status).toBe("waiting_for_allowance");
    expect(cs.uploadWorkspace.documentStatus.waiting_for_allowance).toBe(
      "Dosažen limit počtu zpracovaných dokladů, kontaktujte super administrátora.",
    );
  });

  it("releases a reservation when provider resolution refuses the work", async () => {
    const { superAdministrator, configurationId, company } = await companyWithDefaultAi("Provider refusal release", 1);
    const provider = { ...fakeAiProvider(), name: "anthropic" };
    const splittingWorker = testWorker(provider);
    const uploaded = await uploadSourceFile(company.client, splittingWorker.jobs, {
      companyId: company.companyId,
      fileName: "provider-refusal.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await splittingWorker.runNextJob();
    splittingWorker.queued.splice(0);
    const [document] = await listCompanyDocuments(company.client, company.companyId);

    const unavailableWorker = testWorker([]);
    unavailableWorker.queued.push({ name: "extract-document", data: { documentId: document.id } });
    expect(await unavailableWorker.runJobs({ final: false })).toEqual([]);
    expect((await listCompanyDocuments(company.client, company.companyId))[0].status).toBe("waiting_for_platform");
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 0, allowance: 1, waitingDocuments: 0 },
    });

    const retryWorker = testWorker(provider);
    expect(await updateAiConfiguration(superAdministrator.client, {
      id: configurationId,
      label: `Provider refusal repaired ${configurationId}`,
      provider: "anthropic",
      splitModel: "allowance-split",
      extractModel: "allowance-extract",
    }, retryWorker.jobs)).toEqual({ ok: true, value: null });
    expect(await retryWorker.runJobs()).toEqual([]);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 1, allowance: 1, waitingDocuments: 0 },
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

  it("selects Documents for finite allowance in page order even when jobs start in reverse", async () => {
    const { company } = await companyWithDefaultAi("Deterministic dispatch", 1);
    const worker = testWorker({ ...fakeAiProvider(), name: "anthropic" });
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "deterministic-dispatch.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    await worker.runNextJob();
    expect(worker.queued).toHaveLength(2);
    worker.queued.reverse();
    expect(await worker.runJobs()).toEqual([]);
    worker.releaseDelayedJobs();
    expect(await worker.runJobs()).toEqual([]);
    expect(await listCompanyDocuments(company.client, company.companyId)).toEqual([
      expect.objectContaining({ firstPage: 1, status: "needs_review" }),
      expect.objectContaining({ firstPage: 2, status: "waiting_for_allowance" }),
    ]);
  });

  it("resumes waiting Documents oldest-first for finite capacity, or all when unlimited", async () => {
    const { superAdministrator, company } = await companyWithDefaultAi("Oldest resume", 0);
    const worker = testWorker({ ...fakeAiProvider(), name: "anthropic" });
    const firstSource = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "oldest-source.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!firstSource.ok) throw new Error(firstSource.error);
    expect(await worker.runJobs()).toEqual([]);
    const secondSource = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "newer-source.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!secondSource.ok) throw new Error(secondSource.error);
    expect(await worker.runJobs()).toEqual([]);
    expect((await listCompanyDocuments(company.client, company.companyId)).filter(
      (document) => document.status === "waiting_for_allowance",
    )).toHaveLength(4);

    expect(await setCompanyAiProcessingAllowance(superAdministrator.client, worker.jobs, {
      companyId: company.companyId,
      allowance: 1,
    })).toEqual({ ok: true, value: null });
    expect(worker.queued).toHaveLength(4);
    worker.queued.reverse();
    expect(await worker.runJobsConcurrently()).toEqual([]);
    worker.releaseDelayedJobs();
    expect(await worker.runJobsConcurrently()).toEqual([]);
    expect(await listCompanyDocuments(company.client, company.companyId)).toContainEqual(
      expect.objectContaining({ sourceFileId: firstSource.value.id, firstPage: 1, status: "needs_review" }),
    );

    expect(await setCompanyAiProcessingAllowance(superAdministrator.client, worker.jobs, {
      companyId: company.companyId,
      allowance: 2,
    })).toEqual({ ok: true, value: null });
    expect(worker.queued).toHaveLength(3);
    worker.queued.reverse();
    expect(await worker.runJobsConcurrently()).toEqual([]);
    worker.releaseDelayedJobs();
    expect(await worker.runJobsConcurrently()).toEqual([]);
    expect(await listCompanyDocuments(company.client, company.companyId)).toContainEqual(
      expect.objectContaining({ sourceFileId: firstSource.value.id, firstPage: 2, status: "needs_review" }),
    );

    expect(await setCompanyAiProcessingAllowance(superAdministrator.client, worker.jobs, {
      companyId: company.companyId,
      allowance: null,
    })).toEqual({ ok: true, value: null });
    expect(worker.queued).toHaveLength(2);
    expect(await worker.runJobs()).toEqual([]);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 4, allowance: null, waitingDocuments: 0 },
    });
  });

  it("restores waiting state after an uncertain queue send and safely recovers without duplicate consumption", async () => {
    const { superAdministrator, company } = await companyWithDefaultAi("Resume queue recovery", 0);
    const fake = fakeAiProvider();
    let extractionCalls = 0;
    const worker = testWorker({
      ...fake,
      name: "anthropic",
      async extract(input, context) {
        extractionCalls += 1;
        return fake.extract(input, context);
      },
    });
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "queue-recovery.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect(await worker.runJobs()).toEqual([]);

    await expect(setCompanyAiProcessingAllowance(superAdministrator.client, {
      async send(job) {
        // The broker may have accepted a job even though its acknowledgement
        // was lost. Recovery must therefore tolerate this duplicate.
        worker.queued.push(job);
        throw new Error("queue acknowledgement lost");
      },
    }, {
      companyId: company.companyId,
      allowance: 2,
    })).rejects.toThrow("queue acknowledgement lost");
    expect((await listCompanyDocuments(company.client, company.companyId)).map((document) => document.status))
      .toEqual(["waiting_for_allowance", "waiting_for_allowance"]);

    expect(await setCompanyAiProcessingAllowance(superAdministrator.client, worker.jobs, {
      companyId: company.companyId,
      allowance: 2,
    })).toEqual({ ok: true, value: null });
    expect(await worker.runJobsConcurrently()).toEqual([]);
    worker.releaseDelayedJobs();
    expect(await worker.runJobsConcurrently()).toEqual([]);
    const documents = await listCompanyDocuments(company.client, company.companyId);
    expect(documents.map((document) => document.status)).toEqual(["needs_review", "needs_review"]);
    expect(extractionCalls).toBe(2);
    expect(await Promise.all(documents.map((document) =>
      listExtractionVersions(company.client, company.companyId, document.id)
    ))).toEqual([[expect.any(Object)], [expect.any(Object)]]);
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
    worker.releaseDelayedJobs();
    expect(await worker.runJobs()).toEqual([]);
    const documents = await listCompanyDocuments(company.client, company.companyId);
    expect(documents.filter((document) => document.status === "needs_review")).toHaveLength(1);
    expect(documents.filter((document) => document.status === "waiting_for_allowance")).toHaveLength(1);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toEqual({
      ok: true,
      value: { used: 1, allowance: 1, waitingDocuments: 1 },
    });
  });

  it("serializes a completion handoff before reserving the last unit", async () => {
    const { company } = await companyWithDefaultAi("Completion handoff", 1);
    const worker = testWorker({ ...fakeAiProvider(), name: "anthropic" });
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "completion-handoff.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    await worker.runNextJob();
    worker.queued.splice(0);

    const system = systemClient();
    const listed = await system
      .from("document")
      .select("id, extraction_request_id")
      .eq("company_id", company.companyId)
      .order("first_page");
    if (listed.error) throw listed.error;
    const [completing, competing] = listed.data;
    const reservationId = crypto.randomUUID();
    const reserved = await system.rpc("reserve_ai_processing", {
      target_document_id: completing.id,
      target_extraction_request_id: completing.extraction_request_id,
      target_reservation_id: reservationId,
    });
    expect(reserved).toEqual(expect.objectContaining({ data: "reserved", error: null }));

    const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
    await database.connect();
    await database.query("begin");
    await database.query("select 1 from public.company where id = $1 for update", [company.companyId]);
    try {
      let completionSettled = false;
      const completion = system.rpc("record_ai_extraction", {
        target_document_id: completing.id,
        target_extraction_request_id: completing.extraction_request_id,
        target_reservation_id: reservationId,
        provider: "anthropic",
        model: "allowance-extract",
        payload: SAMPLE_EXTRACTION,
        findings: [],
      }).then((result) => {
        completionSettled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(completionSettled).toBe(false);

      const competingReservation = system.rpc("reserve_ai_processing", {
        target_document_id: competing.id,
        target_extraction_request_id: competing.extraction_request_id,
        target_reservation_id: crypto.randomUUID(),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await database.query("commit");

      expect(await completion).toEqual(expect.objectContaining({ error: null }));
      expect(await competingReservation).toEqual(expect.objectContaining({
        data: "allowance_exhausted",
        error: null,
      }));
    } finally {
      await database.query("rollback");
      await database.end();
    }

    const documents = await listCompanyDocuments(company.client, company.companyId);
    expect(documents.map((document) => document.status)).toEqual(["needs_review", "waiting_for_allowance"]);
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
