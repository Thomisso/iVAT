import { recoverPhotoGroup } from "@/application/photo-groups";
import { jobQueue } from "@/lib/jobs";
import { requireUserClient } from "@/lib/supabase/server";

/** Intent only: the database owns membership, current access and processing state. */
export async function POST(request: Request, context: RouteContext<"/companies/[companyId]/photo-groups/[groupId]/recovery">) {
  const body = await request.json().catch(() => null);
  if (body?.mode !== "manual" && body?.mode !== "retry") return Response.json({ ok: false, error: "invalid_choice" }, { status: 400 });
  const result = await recoverPhotoGroup(await requireUserClient(), jobQueue, { ...await context.params, mode: body.mode });
  return Response.json(result, { status: result.ok ? 200 : result.error === "forbidden" ? 403 : 400, headers: { "Cache-Control": "no-store" } });
}
