import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/** Forces one terminal Extraction failure for a browser recovery fixture. */
export async function failOneDocumentInUploadBatch(batchId: string): Promise<void> {
  const contents = await fs.readFile(".env.local", "utf8");
  const environment = Object.fromEntries(contents.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const service = createClient<Database>(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    environment.SUPABASE_SECRET_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data: sources, error: sourceError } = await service
    .from("source_file")
    .select("id")
    .eq("upload_batch_id", batchId);
  if (sourceError || sources.length !== 1) throw sourceError ?? new Error("Expected one Source File");
  const { data: documents, error: documentError } = await service
    .from("document")
    .select("id")
    .eq("source_file_id", sources[0].id)
    .order("first_page");
  if (documentError || documents.length !== 2) throw documentError ?? new Error("Expected two Documents");
  const failed = await service.from("document").update({ status: "failed" }).eq("id", documents[1].id);
  if (failed.error) throw failed.error;
}
