// Process liveness deliberately has no session, Auth or database dependencies.
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
