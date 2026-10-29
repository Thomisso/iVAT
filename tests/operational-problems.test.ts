import { describe, expect, it } from "vitest";
import type { AiConfigurationSummary } from "@/application/ai-configurations";
import type { PlatformAiProcessingAllowance } from "@/application/ai-processing-allowance";
import type { PlatformAiProcessingIssue } from "@/application/ai-processing-interventions";
import { groupOperationalProblems } from "@/application/operational-problems";

const now = "2026-11-12T12:00:00.000Z";

function allowance(input: Partial<PlatformAiProcessingAllowance> & Pick<PlatformAiProcessingAllowance, "companyId" | "companyName">): PlatformAiProcessingAllowance {
  return {
    organizationId: `organization-${input.companyId}`,
    organizationName: `Organization ${input.companyName}`,
    configurationId: null,
    configurationLabel: null,
    provider: null,
    used: 0,
    allowance: 100,
    waitingDocuments: 0,
    ...input,
  };
}

function company(input: {
  companyId: string;
  companyName: string;
  aiProcessingEnabled?: boolean;
  uploadedDocumentCount?: number;
}) {
  return {
    aiProcessingEnabled: input.aiProcessingEnabled ?? true,
    uploadedDocumentCount: input.uploadedDocumentCount ?? 0,
    oldestUploadedAt: input.uploadedDocumentCount ? "2026-11-12T10:00:00.000Z" : null,
    oldestWaitingAt: input.uploadedDocumentCount ? "2026-11-12T10:00:00.000Z" : null,
    ...input,
  };
}

function issue(input: Partial<PlatformAiProcessingIssue> & Pick<PlatformAiProcessingIssue, "companyId" | "companyName">): PlatformAiProcessingIssue {
  return {
    targetKind: "document",
    targetId: crypto.randomUUID(),
    state: "waiting_for_platform",
    classification: "provider_unavailable",
    configurationId: null,
    configurationLabel: null,
    provider: null,
    firstDetectedAt: "2026-11-12T09:00:00.000Z",
    ...input,
  };
}

function configuration(id: string): AiConfigurationSummary {
  return {
    id,
    label: "Shared production",
    provider: "anthropic",
    credentialLastFour: "7xYz",
    isDefault: true,
    assignedCompanyIds: [],
  };
}

describe("operational problem grouping", () => {
  it("reports allowance use at 80% and exhaustion but not 79%", () => {
    const allowances = [
      allowance({ companyId: "company-79", companyName: "Seventy nine", used: 79 }),
      allowance({ companyId: "company-80", companyName: "Eighty", used: 80 }),
      allowance({ companyId: "company-100", companyName: "Exhausted", used: 100 }),
    ];

    const result = groupOperationalProblems({
      allowances,
      configurations: [],
      context: { companies: allowances.map((entry) => company(entry)), failedJobs: [] },
      issues: [],
      now,
    });

    expect(result.map((problem) => [problem.kind, problem.companies[0].id])).toEqual([
      ["allowance_exhausted", "company-100"],
      ["allowance_high", "company-80"],
    ]);
  });

  it("groups a shared root cause by configuration and exposes only the credential suffix", () => {
    const configurationId = crypto.randomUUID();
    const companies = [
      company({ companyId: "company-a", companyName: "Alpha" }),
      company({ companyId: "company-b", companyName: "Beta" }),
    ];

    const result = groupOperationalProblems({
      allowances: companies.map((entry) => allowance({
        companyId: entry.companyId,
        companyName: entry.companyName,
        configurationId,
      })),
      configurations: [configuration(configurationId)],
      context: { companies, failedJobs: [] },
      issues: companies.map((entry) => issue({
        companyId: entry.companyId,
        companyName: entry.companyName,
        configurationId,
        configurationLabel: "Shared production",
        provider: "anthropic",
      })),
      now,
    });

    expect(result).toEqual([expect.objectContaining({
      kind: "provider_unavailable",
      affectedDocumentCount: 2,
      configuration: {
        id: configurationId,
        label: "Shared production",
        provider: "anthropic",
        credentialLastFour: "7xYz",
      },
      companies: [
        { id: "company-a", name: "Alpha", affectedDocumentCount: 1 },
        { id: "company-b", name: "Beta", affectedDocumentCount: 1 },
      ],
    })]);
    expect(JSON.stringify(result)).not.toContain("credential_secret");
  });

  it("ignores intentionally disabled AI until Documents are actually waiting", () => {
    const quiet = company({ companyId: "quiet", companyName: "Quiet", aiProcessingEnabled: false });
    const waiting = company({
      companyId: "waiting",
      companyName: "Waiting",
      aiProcessingEnabled: false,
      uploadedDocumentCount: 3,
    });

    const result = groupOperationalProblems({
      allowances: [],
      configurations: [],
      context: { companies: [quiet, waiting], failedJobs: [] },
      issues: [],
      now,
    });

    expect(result).toEqual([expect.objectContaining({
      kind: "waiting_documents",
      severity: "critical",
      affectedDocumentCount: 3,
      companies: [{ id: "waiting", name: "Waiting", affectedDocumentCount: 3 }],
    })]);
  });

  it("groups terminal attempts and disappears when authoritative inputs resolve", () => {
    const active = groupOperationalProblems({
      allowances: [],
      configurations: [],
      context: {
        companies: [company({ companyId: "company-a", companyName: "Alpha" })],
        failedJobs: [
          {
            name: "extract-document",
            companyId: "company-a",
            companyName: "Alpha",
            affectedCount: 2,
            firstFailedAt: "2026-11-12T08:00:00.000Z",
          },
          {
            name: "extract-document",
            companyId: "company-a",
            companyName: "Alpha",
            affectedCount: 1,
            firstFailedAt: "2026-11-12T10:00:00.000Z",
          },
        ],
      },
      issues: [],
      now,
    });
    expect(active).toEqual([expect.objectContaining({
      kind: "terminal_processing_job",
      affectedDocumentCount: 3,
      firstDetectedAt: "2026-11-12T08:00:00.000Z",
    })]);

    expect(groupOperationalProblems({
      allowances: [],
      configurations: [],
      context: { companies: [], failedJobs: [] },
      issues: [],
      now,
    })).toEqual([]);
  });
});
