import { execFileSync } from "node:child_process";
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees, rgb } from "pdf-lib";
import sharp from "sharp";
import { expect, it } from "vitest";
import { prepareExtractionInput } from "@/application/pdf-extraction";

it.each([
  [0, 400, 200, [40, 140, 79, 159]],
  [90, 200, 400, [40, 40, 59, 79]],
  [180, 400, 200, [320, 40, 359, 59]],
  [270, 200, 400, [140, 320, 159, 359]],
])("rasterizes rotation %i with the visible page basis and blank margins", async (rotation, width, height, bounds) => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  page.setCropBox(50, 30, 200, 100);
  page.setMediaBox(10, 20, 400, 300);
  page.setRotation(degrees(rotation as number));
  page.drawRectangle({ x: 70, y: 50, width: 20, height: 10, color: rgb(1, 0, 0) });
  const bytes = await pdf.save();
  const input = await prepareExtractionInput({ format: "pdf", mediaType: "application/pdf", bytes, pageCount: 1 });
  expect(input.format).toBe("pdf");
  expect(input.bytes).toEqual(bytes);
  expect(input.pageImages).toHaveLength(1);
  const image = input.pageImages![0];
  expect(image).toMatchObject({ mediaType: "image/png", width, height });
  const { data, info } = await sharp(image.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const red: number[][] = [];
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const index = (y * info.width + x) * info.channels;
    if (data[index] > 200 && data[index + 1] < 50 && data[index + 2] < 50) red.push([x, y]);
  }
  // Literal pixel bounds worked independently from the PDF rectangle and rotation.
  expect([Math.min(...red.map(p => p[0])), Math.min(...red.map(p => p[1])),
    Math.max(...red.map(p => p[0])), Math.max(...red.map(p => p[1]))]).toEqual(bounds);
});

it("refuses oversized PDF pages before raster allocation and never substitutes native PDF input", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([10_000, 10_000]);
  await expect(prepareExtractionInput({ format: "pdf", mediaType: "application/pdf", bytes: await pdf.save(), pageCount: 1 }))
    .rejects.toMatchObject({ code: "pdf_render_limit", transient: false, classification: "processing_failed" });
});

it("refuses unreadable PDF input without exposing its contents", async () => {
  await expect(prepareExtractionInput({ format: "pdf", mediaType: "application/pdf", bytes: new Uint8Array([1, 2, 3]), pageCount: 1 }))
    .rejects.toMatchObject({ code: "pdf_render_failed", message: "PDF pages could not be rendered for Extraction" });
});

it.each([[2, 800, 400], [0.5, 200, 100]])("applies UserUnit %s before checking and rendering the pixel budget", async (unit, width, height) => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  page.setCropBox(50, 30, 200, 100);
  page.node.set(PDFName.of("UserUnit"), PDFNumber.of(unit));
  const bytes = await pdf.save();
  const input = await prepareExtractionInput({ format: "pdf", mediaType: "application/pdf", bytes, pageCount: 1 });
  expect(input.pageImages![0]).toMatchObject({ width, height });
  expect(input.bytes).toEqual(bytes);
});

it("aligns raster text with independently extracted text-layer bounds on a portrait page", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("INVOICE253", { x: 60, y: 300, size: 20, font });
  const bytes = await pdf.save();
  const text = execFileSync("pdftotext", ["-bbox", "-", "-"], { input: bytes }).toString();
  const word = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">INVOICE253<\/word>/.exec(text)!;
  expect(word).not.toBeNull();
  const [x0, y0, x1, y1] = word.slice(1).map(Number);
  const input = await prepareExtractionInput({ format: "pdf", mediaType: "application/pdf", bytes, pageCount: 1 });
  expect(input.pageImages![0]).toMatchObject({ width: 600, height: 800 });
  const { data, info } = await sharp(input.pageImages![0].bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = 0, bottom = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * info.channels] < 100) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
  }
  // Compare independent PDF text analysis with the actual raster's ink envelope.
  const intersection = Math.max(0, Math.min(right, x1 * 2) - Math.max(left, x0 * 2))
    * Math.max(0, Math.min(bottom, y1 * 2) - Math.max(top, y0 * 2));
  const union = (right - left) * (bottom - top) + (x1 - x0) * (y1 - y0) * 4 - intersection;
  expect(intersection / union).toBeGreaterThanOrEqual(0.5);
});
