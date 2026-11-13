import type { SystemClient } from "./client";

/** Removes only retired temporary scopes. Tombstones survive every sweep so a
 * Storage write admitted before retirement is still collected if it lands late. */
export async function runSourceUploadCleanupTick(system: SystemClient): Promise<void> {
  const retired = await system.rpc("retire_source_uploads");
  if (retired.error) throw retired.error;
  const candidates = await system.rpc("source_upload_cleanup_candidates");
  if (candidates.error) throw candidates.error;
  for (const candidate of candidates.data as { attemptId: string; names: string[] }[]) {
    // A failed removal leaves the same durable scope discoverable. Updating the
    // sweep time gives other scopes a turn; no success or empty result forgets it.
    if (candidate.names.length) await system.storage.from("source-upload-chunks").remove(candidate.names);
    const finished = await system.rpc("finish_source_upload_cleanup_sweep", { target_attempt_id: candidate.attemptId });
    if (finished.error) throw finished.error;
  }
}
