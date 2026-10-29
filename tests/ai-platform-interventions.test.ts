import { Client as DatabaseClient } from "pg";
import { afterEach, describe, expect, inject, it } from "vitest";
import { AiProviderError, type AiProvider } from "@/application/ai-provider";
import {
  assignCompanyAiConfiguration,
  createAiConfiguration,
  clearDefaultAiConfiguration,
  resumePlatformAiProcessing,
  setDefaultAiConfiguration,
  updateAiConfiguration,
} from "@/application/ai-configurations";
import { listPlatformAiProcessingIssues } from "@/application/ai-processing-interventions";
import { listPlatformAuditEvents } from "@/application/audit";
import { listCompanyDocuments } from "@/application/documents";
import { splitJob, type ProcessingJob } from "@/application/processing";
import { getSourceFile, uploadSourceFile } from "@/application/source-files";
import { fakeAiProvider } from "@/ai/fake";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { promotedSuperAdministrator } from "./support/platform";
import { testWorker } from "./support/worker";
import cs from "../messages/cs.json";
import en from "../messages/en.json";
import { PROCESSING_JOB_QUEUE_OPTIONS } from "@/lib/processing-policy";

const defaultsToClear: Awaited<ReturnType<typeof promotedSuperAdministrator>>[] = [];

afterEach(async () => {
  for (const operator of defaultsToClear.splice(0)) {
    await clearDefaultAiConfiguration(operator.client);
  }
});

async function configuredCompany(name: string) {
  const superAdministrator = await promotedSuperAdministrator(`${name} operator`, `intervention-${name}`);
  defaultsToClear.push(superAdministrator);
  const configuration = await createAiConfiguration(superAdministrator.client, {
    label: `${name} ${superAdministrator.userId}`,
    provider: "anthropic",
    splitModel: "intervention-split",
    extractModel: "intervention-extract",
    credential: "incorrect-secret",
  });
  if (!configuration.ok) throw new Error(configuration.error);
  const selected = await setDefaultAiConfiguration(superAdministrator.client, configuration.value.id);
  if (!selected.ok) throw new Error(selected.error);
  const company = await administratorWithCompany(name);
  return { superAdministrator, configurationId: configuration.value.id, company };
}

describe("AI processing states requiring platform intervention", () => {
  it("waits without retrying on invalid credentials, scopes the cause, and resumes after correction", async () => {
    const { superAdministrator, configurationId, company } = await configuredCompany("Invalid credential");
    const companyAdministrator = await companyMember(company, "administrator");
    const user = await companyMember(company, "user");
    let credentialIsValid = false;
    let splitCalls = 0;
    const fake = fakeAiProvider();
    const provider: AiProvider = {
      ...fake,
      name: "anthropic",
      async split(input, context) {
        splitCalls += 1;
        if (!credentialIsValid) {
          throw new AiProviderError("anthropic_request_failed", "invalid credential", {
            transient: false,
            classification: "invalid_credentials",
            platformIntervention: true,
          });
        }
        return fake.split(input, context);
      },
    };
    const worker = testWorker(provider);
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "invalid-credential.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs()).toEqual([]);
    expect(splitCalls).toBe(1);
    expect(worker.delayed).toEqual([]);
    expect((await getSourceFile(user.client, company.companyId, uploaded.value.id))?.status)
      .toBe("waiting_for_platform");
    expect(await listPlatformAiProcessingIssues(user.client)).toEqual({ ok: false, error: "forbidden" });
    expect(await listPlatformAiProcessingIssues(companyAdministrator.client)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await listPlatformAiProcessingIssues(superAdministrator.client)).toEqual({
      ok: true,
      value: expect.arrayContaining([expect.objectContaining({
        targetKind: "source_file",
        targetId: uploaded.value.id,
        state: "waiting_for_platform",
        classification: "invalid_credentials",
        companyId: company.companyId,
        companyName: "Novák s.r.o.",
        configurationId,
        configurationLabel: expect.stringContaining("Invalid credential"),
        provider: "anthropic",
      })]),
    });

    credentialIsValid = true;
    expect(await updateAiConfiguration(superAdministrator.client, {
      id: configurationId,
      label: `${company.companyId} repaired`,
      provider: "anthropic",
      splitModel: "intervention-split",
      extractModel: "intervention-extract",
      credential: "corrected-secret",
    }, worker.jobs)).toEqual({ ok: true, value: null });
    expect(await worker.runJobs()).toEqual([]);
    expect(splitCalls).toBe(2);
    expect((await getSourceFile(user.client, company.companyId, uploaded.value.id))?.status).toBe("split");
    const afterRecovery = await listPlatformAiProcessingIssues(superAdministrator.client);
    expect(afterRecovery).toEqual({ ok: true, value: expect.any(Array) });
    if (!afterRecovery.ok) throw new Error(afterRecovery.error);
    expect(afterRecovery.value.find((issue) => issue.targetId === uploaded.value.id)).toBeUndefined();
  });

  it("holds a Document for provider-credit intervention behind a neutral User status", async () => {
    const { superAdministrator, configurationId, company } = await configuredCompany("Provider credits");
    const user = await companyMember(company, "user");
    let extractionCalls = 0;
    let creditsAvailable = false;
    const fake = fakeAiProvider();
    const provider: AiProvider = {
      ...fake,
      name: "anthropic",
      async extract(input, context) {
        extractionCalls += 1;
        if (creditsAvailable) return fake.extract(input, context);
        throw new AiProviderError("anthropic_request_failed", "credit balance exhausted", {
          transient: false,
          classification: "provider_credits_exhausted",
          platformIntervention: true,
        });
      },
    };
    const worker = testWorker(provider);
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "provider-credits.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs()).toEqual([]);
    expect(extractionCalls).toBe(1);
    expect(worker.delayed).toEqual([]);
    const [document] = await listCompanyDocuments(user.client, company.companyId);
    expect(document.status).toBe("waiting_for_platform");
    expect(en.documentStatus.waiting_for_platform).toBe("AI processing is waiting for platform intervention.");
    expect(cs.documentStatus.waiting_for_platform).toBe("Zpracování AI čeká na zásah správce platformy.");
    expect(`${en.documentStatus.waiting_for_platform} ${cs.documentStatus.waiting_for_platform}`)
      .not.toMatch(/anthropic|credential|key|credit|kredit|model/i);

    const issues = await listPlatformAiProcessingIssues(superAdministrator.client);
    expect(issues).toEqual({ ok: true, value: expect.any(Array) });
    if (!issues.ok) throw new Error(issues.error);
    expect(issues.value.find((issue) => issue.targetId === document.id)).toEqual(expect.objectContaining({
      targetKind: "document",
      state: "waiting_for_platform",
      classification: "provider_credits_exhausted",
      configurationId,
      provider: "anthropic",
    }));

    creditsAvailable = true;
    expect(await resumePlatformAiProcessing(superAdministrator.client, worker.jobs, { configurationId }))
      .toEqual({ ok: true, value: null });
    expect(await listPlatformAuditEvents(superAdministrator.client)).toContainEqual(expect.objectContaining({
      actorUserId: superAdministrator.userId,
      action: "ai_processing.remediation_requested",
      targetType: "ai_configuration",
      targetId: configurationId,
      payload: {
        company_id: null,
        configuration_id: configurationId,
        resumed_count: 1,
      },
    }));
    expect(await worker.runJobs()).toEqual([]);
    expect((await listCompanyDocuments(user.client, company.companyId))[0].status).toBe("needs_review");
  });

  it("restores the undispatched suffix after a partial or ambiguously acknowledged remediation dispatch", async () => {
    const { superAdministrator, configurationId, company } = await configuredCompany("Dispatch compensation");
    let creditsAvailable = false;
    const fake = fakeAiProvider();
    const worker = testWorker({
      ...fake,
      name: "anthropic",
      async extract(input, context) {
        if (!creditsAvailable) {
          throw new AiProviderError("anthropic_request_failed", "credit balance exhausted", {
            transient: false,
            classification: "provider_credits_exhausted",
            platformIntervention: true,
          });
        }
        return fake.extract(input, context);
      },
    });
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "dispatch-compensation.pdf",
      bytes: fixtureFile("two-invoices.pdf"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect(await worker.runJobs()).toEqual([]);
    expect((await listCompanyDocuments(company.client, company.companyId)).map(({ status }) => status))
      .toEqual(["waiting_for_platform", "waiting_for_platform"]);
    const beforeRemediation = await listPlatformAiProcessingIssues(superAdministrator.client);
    if (!beforeRemediation.ok) throw new Error(beforeRemediation.error);
    const detectedAtByTarget = new Map(
      beforeRemediation.value.map(({ targetId, firstDetectedAt }) => [targetId, firstDetectedAt]),
    );

    creditsAvailable = true;
    const accepted: ProcessingJob[] = [];
    await expect(resumePlatformAiProcessing(superAdministrator.client, {
      async send(job) {
        accepted.push(job);
        worker.queued.push(job);
        if (accepted.length === 2) throw new Error("queue acknowledgement lost");
      },
    }, { configurationId })).rejects.toThrow("queue acknowledgement lost");

    const acceptedIds = accepted.map((job) => {
      if (job.name !== "extract-document") throw new Error("Expected only Extraction remediation work");
      return job.data.documentId;
    });
    const failedTarget = acceptedIds[1];
    expect(await listCompanyDocuments(company.client, company.companyId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: failedTarget, status: "waiting_for_platform" }),
      expect.objectContaining({ id: acceptedIds[0], status: "uploaded" }),
    ]));
    const compensated = await listPlatformAiProcessingIssues(superAdministrator.client);
    if (!compensated.ok) throw new Error(compensated.error);
    expect(compensated.value.filter(({ targetId }) => targetId === failedTarget)).toEqual([
      expect.objectContaining({
        state: "waiting_for_platform",
        classification: "provider_credits_exhausted",
        configurationId,
        firstDetectedAt: detectedAtByTarget.get(failedTarget),
      }),
    ]);

    expect(await worker.runJobsConcurrently()).toEqual([]);
    expect((await listCompanyDocuments(company.client, company.companyId)).map(({ status }) => status))
      .toEqual(["needs_review", "needs_review"]);
  });

  it.each([
    ["waiting", "waiting_for_platform", "provider_credits_exhausted"],
    ["terminal", "failed", "provider_response_invalid"],
  ] as const)("keeps the first concurrent %s decision against a stale conflicting handler", async (
    firstDecision,
    expectedStatus,
    expectedClassification,
  ) => {
    const { superAdministrator, company } = await configuredCompany("Concurrent classification");
    let splitCalls = 0;
    let releaseWaiting!: () => void;
    let releaseTerminal!: () => void;
    let bothStarted!: () => void;
    const waitingGate = new Promise<void>((resolve) => { releaseWaiting = resolve; });
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    const provider: AiProvider = {
      ...fakeAiProvider(),
      name: "anthropic",
      async split() {
        splitCalls += 1;
        const call = splitCalls;
        if (call === 2) bothStarted();
        await (call === 1 ? waitingGate : terminalGate);
        throw new AiProviderError("anthropic_request_failed", call === 1 ? "credits" : "bad response", {
          transient: false,
          classification: call === 1 ? "provider_credits_exhausted" : "provider_response_invalid",
          platformIntervention: call === 1,
        });
      },
    };
    const worker = testWorker(provider);
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "concurrent-classification.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    worker.queued.push(splitJob(uploaded.value.id));

    const running = worker.runJobsConcurrently();
    await started;
    if (firstDecision === "waiting") releaseWaiting();
    else releaseTerminal();
    await expect.poll(async () =>
      (await getSourceFile(company.client, company.companyId, uploaded.value.id))?.status
    ).toBe(expectedStatus);
    if (firstDecision === "waiting") releaseTerminal();
    else releaseWaiting();
    expect(await running).toEqual([expect.any(AiProviderError)]);

    expect((await getSourceFile(company.client, company.companyId, uploaded.value.id))?.status)
      .toBe(expectedStatus);
    const issues = await listPlatformAiProcessingIssues(superAdministrator.client);
    if (!issues.ok) throw new Error(issues.error);
    expect(issues.value.find(({ targetId }) => targetId === uploaded.value.id)).toEqual(expect.objectContaining({
      state: firstDecision === "waiting" ? "waiting_for_platform" : "terminal",
      classification: expectedClassification,
    }));
  });

  it("uses the exact retry budget for transient unavailability before recording a terminal failure", async () => {
    const { superAdministrator, configurationId, company } = await configuredCompany("Transient outage");
    let splitCalls = 0;
    const fake = fakeAiProvider();
    const provider: AiProvider = {
      ...fake,
      name: "anthropic",
      async split() {
        splitCalls += 1;
        throw new AiProviderError("anthropic_request_failed", "provider unavailable", {
          transient: true,
          classification: "provider_unavailable",
        });
      },
    };
    const worker = testWorker(provider);
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "transient-outage.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    for (let attempt = 0; attempt < PROCESSING_JOB_QUEUE_OPTIONS.retryLimit; attempt += 1) {
      expect(await worker.runJobs({ final: false })).toEqual([expect.any(AiProviderError)]);
      expect((await getSourceFile(company.client, company.companyId, uploaded.value.id))?.status).toBe("processing");
      worker.queued.push(splitJob(uploaded.value.id));
    }
    expect(splitCalls).toBe(3);
    expect(await worker.runJobs({ final: true })).toEqual([expect.any(AiProviderError)]);
    expect(splitCalls).toBe(4);
    expect((await getSourceFile(company.client, company.companyId, uploaded.value.id))?.status).toBe("failed");

    const issues = await listPlatformAiProcessingIssues(superAdministrator.client);
    expect(issues).toEqual({ ok: true, value: expect.any(Array) });
    if (!issues.ok) throw new Error(issues.error);
    expect(issues.value.find((issue) => issue.targetId === uploaded.value.id)).toEqual(expect.objectContaining({
      state: "terminal",
      classification: "provider_unavailable",
      configurationId,
      provider: "anthropic",
    }));

    expect(await updateAiConfiguration(superAdministrator.client, {
      id: configurationId,
      label: `${company.companyId} after outage`,
      provider: "anthropic",
      splitModel: "intervention-split",
      extractModel: "intervention-extract",
    }, worker.jobs)).toEqual({ ok: true, value: null });
    expect(worker.queued).toEqual([]);
    expect((await getSourceFile(company.client, company.companyId, uploaded.value.id))?.status).toBe("failed");
  });

  it("waits on an unusable assigned configuration and identifies it to the SuperAdmin", async () => {
    const { superAdministrator, configurationId, company } = await configuredCompany("Unusable configuration");
    expect(await assignCompanyAiConfiguration(superAdministrator.client, {
      companyId: company.companyId,
      configurationId,
    })).toEqual({ ok: true, value: null });
    const worker = testWorker();
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "unusable-configuration.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs()).toEqual([]);
    expect((await getSourceFile(company.client, company.companyId, uploaded.value.id))?.status)
      .toBe("waiting_for_platform");
    const issues = await listPlatformAiProcessingIssues(superAdministrator.client);
    expect(issues).toEqual({ ok: true, value: expect.any(Array) });
    if (!issues.ok) throw new Error(issues.error);
    expect(issues.value.find((issue) => issue.targetId === uploaded.value.id)).toEqual(expect.objectContaining({
      state: "waiting_for_platform",
      classification: "configuration_unusable",
      configurationId,
      provider: "anthropic",
    }));
  });

  it("represents a missing assigned credential as platform-intervention waiting", async () => {
    const { superAdministrator, configurationId, company } = await configuredCompany("Missing configuration");
    const database = new DatabaseClient({ connectionString: inject("databaseUrl") });
    await database.connect();
    try {
      await database.query(
        `delete from vault.secrets
         where id = (select credential_secret_id from public.ai_configuration where id = $1)`,
        [configurationId],
      );
    } finally {
      await database.end();
    }
    const worker = testWorker({ ...fakeAiProvider(), name: "anthropic" });
    const uploaded = await uploadSourceFile(company.client, worker.jobs, {
      companyId: company.companyId,
      fileName: "missing-configuration.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);

    expect(await worker.runJobs()).toEqual([]);
    expect((await getSourceFile(company.client, company.companyId, uploaded.value.id))?.status)
      .toBe("waiting_for_platform");
    const issues = await listPlatformAiProcessingIssues(superAdministrator.client);
    expect(issues).toEqual({ ok: true, value: expect.any(Array) });
    if (!issues.ok) throw new Error(issues.error);
    expect(issues.value.find((issue) => issue.targetId === uploaded.value.id)).toEqual(expect.objectContaining({
      classification: "configuration_missing",
      configurationId,
      provider: "anthropic",
    }));
  });
});
