import type { AppClient } from "@/application/client";
import { reconcileSourceUpload, type SourceUploadIdentity } from "@/application/source-upload-transfers";

export async function sourceUploadAttempt(client: AppClient, identity: SourceUploadIdentity) {
  const state = await reconcileSourceUpload(client, identity);
  if (!state.ok) throw new Error(state.error);
  return { ...identity, expectedAttemptId: state.value.attemptId };
}

import { inject } from "vitest";
import { supabaseSourceUploadValidation } from "@/source-uploads/supabase-validation";
import { completeSourceUpload as complete, type SourceUploadAttempt, type SourceUploadValidation } from "@/application/source-upload-transfers";
import type { JobQueue } from "@/application/processing";
export function sourceUploadValidator(url=inject("supabaseUrl")) { return supabaseSourceUploadValidation({url,secretKey:inject("supabaseSecretKey")}); }
export function completeSourceUpload(client: AppClient,jobs:JobQueue,identity:SourceUploadAttempt,validator:SourceUploadValidation=sourceUploadValidator()) {return complete(client,jobs,identity,validator);}

import { uploadSourceFile as upload, type UploadSourceFileInput } from "@/application/source-files";
export function uploadSourceFile(client:AppClient,jobs:JobQueue,input:UploadSourceFileInput) { return upload(client,jobs,input,sourceUploadValidator()); }
