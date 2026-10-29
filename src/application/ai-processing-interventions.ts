import type { AiProcessingIssueClassification } from "./ai-provider";
import type { AppClient, Result } from "./client";

export type PlatformAiProcessingIssue = {
  targetKind: "source_file" | "document";
  targetId: string;
  state: "waiting_for_platform" | "terminal";
  classification: AiProcessingIssueClassification;
  companyId: string;
  companyName: string;
  configurationId: string | null;
  configurationLabel: string | null;
  provider: string | null;
  firstDetectedAt: string;
};

export async function listPlatformAiProcessingIssues(
  client: AppClient,
): Promise<Result<PlatformAiProcessingIssue[], "forbidden">> {
  const { data, error } = await client.rpc("list_platform_ai_processing_issues");
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error) throw error;
  const issues = data as unknown as {
    target_kind: PlatformAiProcessingIssue["targetKind"];
    target_id: string;
    state: PlatformAiProcessingIssue["state"];
    classification: AiProcessingIssueClassification;
    company_id: string;
    company_name: string;
    configuration_id: string | null;
    configuration_label: string | null;
    provider: string | null;
    first_detected_at: string;
  }[];
  return {
    ok: true,
    value: issues.map((issue) => ({
      targetKind: issue.target_kind,
      targetId: issue.target_id,
      state: issue.state,
      classification: issue.classification,
      companyId: issue.company_id,
      companyName: issue.company_name,
      configurationId: issue.configuration_id,
      configurationLabel: issue.configuration_label,
      provider: issue.provider,
      firstDetectedAt: issue.first_detected_at,
    })),
  };
}
