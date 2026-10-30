import { readVatReportArtifact } from "@/application/epo-export";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: RouteContext<"/companies/[companyId]/vat-reports/[period]/artifacts/[artifactId]">,
) {
  const { companyId, period, artifactId } = await context.params;
  const result = await readVatReportArtifact(await requireUserClient(), { companyId, artifactId });
  if (!result || result.artifact.period !== period) return new Response(null, { status: 404 });
  return new Response(Buffer.from(result.bytes), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": result.artifact.mediaType,
      "Content-Disposition": `attachment; filename="${result.artifact.fileName}"`,
      "X-Content-Type-Options": "nosniff",
      "X-iVAT-Artifact-ID": result.artifact.id,
      "X-iVAT-Report-Generated-At": result.artifact.reportGeneratedAt,
      "Digest": `sha-256=${Buffer.from(result.artifact.sha256, "hex").toString("base64")}`,
    },
  });
}
