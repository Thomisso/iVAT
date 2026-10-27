import { isUuid, type AppClient, type Result } from "./client";

export type UploadBatchError = "file_required" | "too_many_files" | "forbidden";

export type UploadNotification = {
  id: string;
  batchId: string;
  companyId: string;
  fileCount: number;
  createdAt: string;
};

/** Starts one user-selected group of Source Files after enforcing the platform batch limit. */
export async function beginUploadBatch(
  client: AppClient,
  input: { companyId: string; fileCount: number },
): Promise<Result<{ id: string }, UploadBatchError>> {
  const { data, error } = await client.rpc("begin_upload_batch", {
    target_company_id: input.companyId,
    selected_file_count: input.fileCount,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.hint === "file_required" || error.hint === "too_many_files") {
      return { ok: false, error: error.hint };
    }
    throw error;
  }
  return { ok: true, value: { id: data } };
}

/** Marks upload attempts complete; processing completion is detected by database state transitions. */
export async function finishUploadBatch(
  client: AppClient,
  batchId: string,
): Promise<Result<null, "forbidden">> {
  if (!isUuid(batchId)) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc("finish_upload_batch", {
    target_batch_id: batchId,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  return { ok: true, value: null };
}

/** Processing-complete upload notifications for the signed-in User, newest first. */
export async function listUploadNotifications(
  client: AppClient,
  companyId: string,
): Promise<UploadNotification[]> {
  if (!isUuid(companyId)) return [];
  const { data, error } = await client
    .from("notification")
    .select("id, company_id, payload, created_at")
    .eq("company_id", companyId)
    .eq("kind", "upload_batch_finished")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data.map((row) => ({
    id: row.id,
    batchId: String((row.payload as { batchId?: unknown }).batchId ?? ""),
    companyId: row.company_id,
    fileCount: Number((row.payload as { fileCount?: unknown }).fileCount ?? 0),
    createdAt: row.created_at,
  }));
}
