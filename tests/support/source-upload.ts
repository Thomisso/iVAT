import type { AppClient } from "@/application/client";
import { reconcileSourceUpload, type SourceUploadIdentity } from "@/application/source-upload-transfers";

export async function sourceUploadAttempt(client: AppClient, identity: SourceUploadIdentity) {
  const state = await reconcileSourceUpload(client, identity);
  if (!state.ok) throw new Error(state.error);
  return { ...identity, expectedAttemptId: state.value.attemptId };
}
