import type { AppClient, Result } from "./client";
import { MAX_SOURCE_FILE_BYTES } from "@/lib/upload-policy";

export type PlatformCompany = { id: string; name: string; ico: string; deletedAt?: string };
export type PlatformOrganizationCompanyList = {
  id: string;
  name: string;
  blocked: boolean;
  companies: PlatformCompany[];
};

export type PlatformUploadLimits = {
  maxFileBytes: number;
  maxFilePages: number;
  maxBatchFiles: number;
};

/** Platform-wide Organization and Company inventory. SuperAdmin with MFA only. */
export async function listPlatformOrganizationCompanies(
  client: AppClient,
): Promise<Result<PlatformOrganizationCompanyList[], "forbidden">> {
  const { data, error } = await client.rpc("list_platform_organization_companies_complete");
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: data as unknown as PlatformOrganizationCompanyList[] };
}

/** Blocks or unblocks an Organization platform-wide. Idempotent and audited in the database. */
export async function setPlatformOrganizationBlocked(
  client: AppClient,
  input: { organizationId: string; blocked: boolean },
): Promise<Result<null, "forbidden">> {
  const { error } = await client.rpc("set_platform_organization_blocked", {
    target_organization_id: input.organizationId,
    organization_blocked: input.blocked,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: null };
}

export async function getPlatformUploadLimits(
  client: AppClient,
): Promise<Result<PlatformUploadLimits, "forbidden">> {
  const { data, error } = await client.rpc("platform_upload_limits");
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  const limits = data[0];
  if (!limits) throw new Error("Platform upload limits are missing");
  return {
    ok: true,
    value: {
      maxFileBytes: Number(limits.max_source_file_bytes),
      maxFilePages: limits.max_source_file_pages,
      maxBatchFiles: limits.max_upload_batch_files,
    },
  };
}

export async function setPlatformUploadLimits(
  client: AppClient,
  input: PlatformUploadLimits,
): Promise<Result<null, "forbidden" | "invalid_upload_limits">> {
  if (
    !Number.isSafeInteger(input.maxFileBytes) || input.maxFileBytes <= 0 || input.maxFileBytes > MAX_SOURCE_FILE_BYTES
    || !Number.isSafeInteger(input.maxFilePages) || input.maxFilePages <= 0
    || !Number.isSafeInteger(input.maxBatchFiles) || input.maxBatchFiles <= 0
  ) return { ok: false, error: "invalid_upload_limits" };
  const { error } = await client.rpc("set_platform_upload_limits", {
    target_max_source_file_bytes: input.maxFileBytes,
    target_max_source_file_pages: input.maxFilePages,
    target_max_upload_batch_files: input.maxBatchFiles,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "invalid_upload_limits") return { ok: false, error: "invalid_upload_limits" };
    throw error;
  }
  return { ok: true, value: null };
}
