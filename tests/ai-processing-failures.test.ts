import { describe, expect, it } from "vitest";
import { fakeAiProvider } from "@/ai/fake";
import { AiProviderError, withProviderResponse } from "@/application/ai-provider";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { listPlatformAiProcessingIssues } from "@/application/ai-processing-interventions";
import { getDocument, listDocuments } from "@/application/documents";
import { listFailedAiResponses } from "@/application/processing-administration";
import { getSourceFile, uploadSourceFile } from "@/application/source-files";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { promotedSuperAdministrator } from "./support/platform";
import { testWorker } from "./support/worker";

for (const operation of ["Split", "Extraction"] as const) {
  describe(`${operation} failure policy through the worker`, () => {
    async function failingAttempt(error: Error) {
      const company = await administratorWithCompany();
      const worker = testWorker(fakeAiProvider({
        [operation === "Split" ? "split" : "extract"]: () => { throw error; },
      }));
      const assigned = await assignAiConfigurationFixture(company.client, worker.jobs, {
        companyId: company.companyId, provider: worker.ai,
      });
      if (!assigned.ok) throw new Error(assigned.error);
      const uploaded = await uploadSourceFile(company.client, worker.jobs, {
        companyId: company.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png"),
      });
      if (!uploaded.ok) throw new Error(uploaded.error);
      if (operation === "Extraction") await worker.runNextJob();
      const [document] = await listDocuments(company.client, company.companyId, uploaded.value.id);
      const targetId = operation === "Split" ? uploaded.value.id : document.id;
      const status = async () => operation === "Split"
        ? (await getSourceFile(company.client, company.companyId, targetId))?.status
        : (await getDocument(company.client, company.companyId, targetId))?.status;
      return { company, worker, targetId, status };
    }

    it.each([
      { name: "transient retry", transient: true, final: false, platformIntervention: false, status: "processing", state: null, classification: "provider_unavailable" },
      { name: "exhausted transient retry", transient: true, final: true, platformIntervention: false, status: "failed", state: "terminal", classification: "provider_unavailable" },
      { name: "permanent provider failure", transient: false, final: false, platformIntervention: false, status: "failed", state: "terminal", classification: "provider_response_invalid" },
      { name: "platform intervention on the final attempt", transient: false, final: true, platformIntervention: true, status: "waiting_for_platform", state: "waiting_for_platform", classification: "invalid_credentials" },
    ] as const)("preserves $name, diagnostics and unconsumed allowance", async (scenario) => {
      const operator = await promotedSuperAdministrator(`${operation} failure operator`);
      const error = withProviderResponse(new AiProviderError("provider_failed", "Original provider failure", {
        transient: scenario.transient,
        classification: scenario.classification,
        platformIntervention: scenario.platformIntervention,
      }), "Original provider response");
      const { company, worker, targetId, status } = await failingAttempt(error);

      expect(await worker.runJobs({ final: scenario.final })).toEqual(scenario.platformIntervention ? [] : [error]);
      // Releasing an unsuccessful Extraction reservation restores Uploaded;
      // Split has no reservation and remains Processing for its next retry.
      const expectedStatus = operation === "Extraction" && scenario.state === null ? "uploaded" : scenario.status;
      expect(await status()).toBe(expectedStatus);
      expect(worker.delayed).toEqual([]);
      expect(await getCompanyAiProcessingAllowance(company.client, company.companyId))
        .toMatchObject({ ok: true, value: { used: 0 } });
      const issues = await listPlatformAiProcessingIssues(operator.client);
      if (!issues.ok) throw new Error(issues.error);
      const issue = issues.value.find((entry) => entry.targetId === targetId);
      if (scenario.state === null) expect(issue).toBeUndefined();
      else expect(issue).toMatchObject({ state: scenario.state, classification: scenario.classification });
      const responses = await listFailedAiResponses(operator.client);
      if (!responses.ok) throw new Error(responses.error);
      expect(responses.value).toContainEqual(expect.objectContaining({
        targetId,
        targetKind: operation === "Split" ? "source_file" : "document",
        provider: "fake",
        model: operation === "Split" ? "fake-split" : "fake-extract",
        error: "Original provider failure",
        response: "Original provider response",
      }));
    });

    it("preserves the original error and terminal issue when PostgreSQL refuses the diagnostic body", async () => {
      const operator = await promotedSuperAdministrator(`${operation} diagnostic operator`);
      // PostgreSQL text cannot store NUL. Exercise the real diagnostic RPC's
      // refusal while the processing and issue-recording RPCs stay available.
      const error = withProviderResponse(new AiProviderError("provider_failed", "Original invalid response", {
        transient: false, classification: "provider_response_invalid",
      }), "Provider response with \u0000");
      const { worker, targetId, status } = await failingAttempt(error);

      const errors = await worker.runJobs();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(error);
      expect(await status()).toBe("failed");
      const issues = await listPlatformAiProcessingIssues(operator.client);
      if (!issues.ok) throw new Error(issues.error);
      expect(issues.value).toContainEqual(expect.objectContaining({
        targetId, state: "terminal", classification: "provider_response_invalid",
      }));
      const responses = await listFailedAiResponses(operator.client);
      if (!responses.ok) throw new Error(responses.error);
      expect(responses.value.some((entry) => entry.targetId === targetId)).toBe(false);
    });
  });
}
