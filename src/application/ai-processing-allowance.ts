import { extractJob, type JobQueue } from "./processing";
import { isUuid, type AppClient, type Result } from "./client";

export type CompanyAiProcessingAllowance = {
  used: number;
  /** `null` means unlimited processing. */
  allowance: number | null;
  waitingDocuments: number;
};

export type PlatformAiProcessingAllowance = CompanyAiProcessingAllowance & {
  organizationId: string;
  organizationName: string;
  companyId: string;
  companyName: string;
  configurationId: string | null;
  configurationLabel: string | null;
  provider: string | null;
};

type AllowanceError = "forbidden" | "invalid_allowance";

export async function getCompanyAiProcessingAllowance(
  client: AppClient,
  companyId: string,
): Promise<Result<CompanyAiProcessingAllowance, "forbidden">> {
  if (!isUuid(companyId)) return { ok: false, error: "forbidden" };
  const { data, error } = await client.rpc("company_ai_processing_allowance", {
    target_company_id: companyId,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  const row = data[0];
  if (!row) return { ok: false, error: "forbidden" };
  return {
    ok: true,
    value: {
      used: Number(row.used),
      allowance: row.allowance === null ? null : Number(row.allowance),
      waitingDocuments: Number(row.waiting_documents),
    },
  };
}

export async function listPlatformAiProcessingAllowances(
  client: AppClient,
): Promise<Result<PlatformAiProcessingAllowance[], "forbidden">> {
  const { data, error } = await client.rpc("list_platform_ai_processing_allowances");
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return {
    ok: true,
    value: data.map((row) => ({
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      companyId: row.company_id,
      companyName: row.company_name,
      configurationId: row.configuration_id,
      configurationLabel: row.configuration_label,
      provider: row.provider,
      used: Number(row.used),
      allowance: row.allowance === null ? null : Number(row.allowance),
      waitingDocuments: Number(row.waiting_documents),
    })),
  };
}

export async function setCompanyAiProcessingAllowance(
  client: AppClient,
  jobs: JobQueue,
  input: { companyId: string; allowance: number | null },
): Promise<Result<null, AllowanceError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (input.allowance !== null && (!Number.isSafeInteger(input.allowance) || input.allowance < 0)) {
    return { ok: false, error: "invalid_allowance" };
  }
  const { data, error } = await client.rpc("set_company_ai_processing_allowance", {
    target_company_id: input.companyId,
    // PostgREST accepts SQL null for the unlimited mode; generated RPC
    // argument types do not encode nullable function parameters.
    target_allowance: input.allowance as number,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "invalid_allowance") return { ok: false, error: "invalid_allowance" };
    throw error;
  }
  for (let index = 0; index < data.length; index += 1) {
    try {
      await jobs.send(extractJob(data[index].document_id));
    } catch (queueError) {
      const restored = await client.rpc("restore_ai_processing_allowance_wait", {
        target_company_id: input.companyId,
        target_document_ids: data.slice(index).map((row) => row.document_id),
      });
      if (restored.error) throw restored.error;
      throw queueError;
    }
  }
  return { ok: true, value: null };
}
