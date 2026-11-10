import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { AiProviderError, type AiInput, type PdfPageImage } from "./ai-provider";

const execute = promisify(execFile);
// Application limits, deliberately below the providers' request limits. PNGs
// become base64 in JSON; 18 MiB leaves room below Anthropic's 32 MB request cap.
export const PDF_EXTRACTION_LIMITS = {
  dpi: 144, pages: 100, pixelsPerPage: 8_000_000, totalPixels: 100_000_000,
  bytesPerPage: 3 * 1024 * 1024, totalBytes: 18 * 1024 * 1024, milliseconds: 60_000,
} as const;

function failure(code: "pdf_render_failed" | "pdf_render_limit") {
  return new AiProviderError(code, code === "pdf_render_limit"
    ? "PDF exceeds the Extraction rendering limits" : "PDF pages could not be rendered for Extraction", {
    transient: false, classification: "processing_failed",
  });
}

/** A transport derivative only: source identity and coordinates remain PDF-based. */
export async function prepareExtractionInput(input: AiInput): Promise<AiInput> {
  if (input.format !== "pdf" || input.pageImages) return input;
  const limits = PDF_EXTRACTION_LIMITS;
  const deadline = Date.now() + limits.milliseconds;
  let directory: string | undefined;
  try {
    const pdf = await PDFDocument.load(input.bytes, { updateMetadata: false });
    const pages = pdf.getPages();
    if (pages.length !== input.pageCount || !pages.length || pages.length > limits.pages) throw failure("pdf_render_limit");
    let totalPixels = 0;
    let normalizedUnits = false;
    const dimensions = pages.map(page => {
      const media = page.getMediaBox(), crop = page.getCropBox();
      const width = Math.min(media.x + media.width, crop.x + crop.width) - Math.max(media.x, crop.x);
      const height = Math.min(media.y + media.height, crop.y + crop.height) - Math.max(media.y, crop.y);
      const userUnit = page.node.lookupMaybe(PDFName.of("UserUnit"), PDFNumber)?.asNumber() ?? 1;
      const rotation = ((page.getRotation().angle % 360) + 360) % 360;
      if (![0, 90, 180, 270].includes(rotation) || width <= 0 || height <= 0 || userUnit <= 0) throw failure("pdf_render_limit");
      const scale = limits.dpi / 72 * userUnit;
      const w = Math.ceil((rotation % 180 ? height : width) * scale);
      const h = Math.ceil((rotation % 180 ? width : height) * scale);
      totalPixels += w * h;
      // Claude accepts smaller per-image dimensions when sending >20 images.
      const sideLimit = pages.length > 20 ? 2000 : 8000;
      if (![w, h].every(Number.isSafeInteger) || Math.max(w, h) > sideLimit
        || w * h > limits.pixelsPerPage || totalPixels > limits.totalPixels) throw failure("pdf_render_limit");
      // Poppler ignores UserUnit on supported runtimes. Normalize only the
      // private derivative and apply its physical scale explicitly per page.
      if (userUnit !== 1) {
        page.node.set(PDFName.of("UserUnit"), PDFNumber.of(1));
        normalizedUnits = true;
      }
      return { width: w, height: h, dpi: limits.dpi * userUnit };
    });
    directory = await mkdtemp(path.join(tmpdir(), "ivat-pdf-extraction-"));
    const file = path.join(directory, "input.pdf");
    await writeFile(file, normalizedUnits ? await pdf.save() : input.bytes, { mode: 0o600 });
    const pageImages: PdfPageImage[] = [];
    let totalBytes = 0;
    for (let i = 0; i < pages.length; i++) {
      const timeout = Math.min(30_000, deadline - Date.now());
      if (timeout <= 0) throw failure("pdf_render_limit");
      const { stdout } = await execute("pdftoppm", ["-f", String(i + 1), "-l", String(i + 1),
        "-singlefile", "-r", String(dimensions[i].dpi), "-cropbox", "-png", file], {
        encoding: "buffer", maxBuffer: limits.bytesPerPage, timeout, killSignal: "SIGKILL",
      });
      if (stdout.length < 24 || !stdout.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw failure("pdf_render_failed");
      const width = stdout.readUInt32BE(16), height = stdout.readUInt32BE(20);
      // Refuse disagreement between the renderer and preview basis, rather than
      // publishing evidence on an unverified transform (including UserUnit).
      if (width !== dimensions[i].width || height !== dimensions[i].height) throw failure("pdf_render_failed");
      totalBytes += stdout.length;
      if (totalBytes > limits.totalBytes) throw failure("pdf_render_limit");
      pageImages.push({ mediaType: "image/png", bytes: stdout, width, height });
    }
    return { ...input, pageImages };
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    throw failure("pdf_render_failed");
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
