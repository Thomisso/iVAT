// Executed in a disposable copy of the application source with build metadata
// written by the real build command. Each invocation loads a fresh installation.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { asUserClient } from "@/application/client";
import { exportFinalVatReport, exportVatReport, readVatReportArtifact } from "@/application/epo-export";
import type { Database } from "@/lib/database.types";

async function main() {
  const request = JSON.parse(readFileSync(0, "utf8")) as {
    url: string; key: string; accessToken: string;
    kind: "draft" | "final";
    input: { companyId: string; period: string; format: string; details: Record<string, string> };
    archiveIds: string[];
  };
  const client = asUserClient(createClient<Database>(request.url, request.key, {
    global: { headers: { Authorization: `Bearer ${request.accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  }));
  const result = await (request.kind === "final" ? exportFinalVatReport : exportVatReport)(client, request.input);
  if (!result.ok) throw new Error(result.error);
  const archives = await Promise.all(request.archiveIds.map(async artifactId => {
    const stored = await readVatReportArtifact(client, { companyId: request.input.companyId, artifactId });
    if (!stored) throw new Error("Missing archived XML");
    return { artifact: stored.artifact, bytes: Buffer.from(stored.bytes).toString("base64") };
  }));
  console.log(JSON.stringify({ download: { ...result.value, bytes: Buffer.from(result.value.bytes).toString("base64") }, archives }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
