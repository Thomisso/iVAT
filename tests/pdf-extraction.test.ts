import { PDFDocument, degrees, rgb } from "pdf-lib";
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
