import type { SystemClient } from "./client";

/** Removes only retired temporary scopes. Tombstones survive every sweep so a
 * Storage write admitted before retirement is still collected if it lands late. */
export async function runSourceUploadCleanupTick(system: SystemClient): Promise<void> {
  const retired = await system.rpc("retire_source_uploads");
  if (retired.error) throw retired.error;
  const legacyRetired = await system.rpc("retire_source_file_validation_objects");
  if (legacyRetired.error) throw legacyRetired.error;
  const candidates = await system.rpc("source_upload_cleanup_candidates");
  if (candidates.error) throw candidates.error;
  const failures: unknown[] = [];
  const remove = async (bucket: string, names: string[]) => {
    if (!names.length) return;
    try {
      const removed = await system.storage.from(bucket).remove(names);
      if (removed.error) failures.push(removed.error);
    } catch (error) { failures.push(error); }
  };
  for (const candidate of candidates.data as { attemptId: string; names: string[] }[]) {
    // A failed removal leaves the same durable scope discoverable. Updating the
    // sweep time gives other scopes a turn; no success or empty result forgets it.
    await remove("source-upload-chunks", candidate.names);
    const finished = await system.rpc("finish_source_upload_cleanup_sweep", { target_attempt_id: candidate.attemptId });
    if (finished.error) failures.push(finished.error);
  }
  const originals = await system.rpc("source_upload_original_cleanup_candidates");
  if (originals.error) failures.push(originals.error);
  else for (const scope of originals.data as { ownerId: string; legacy: boolean; names: string[] }[]) {
    await remove("source-files", scope.names);
    const finished = await system.rpc("finish_source_upload_original_sweep", { owner_id: scope.ownerId, legacy: scope.legacy });
    if (finished.error) failures.push(finished.error);
  }
  if (failures.length) throw new AggregateError(failures, "Temporary upload cleanup failed");
}
