import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
/** Public, version-matched renderer code only. Filing data never reaches this route. */
export async function GET() {
  const worker = await readFile(path.join(process.cwd(), "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"));
  return new Response(worker, { headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
}
