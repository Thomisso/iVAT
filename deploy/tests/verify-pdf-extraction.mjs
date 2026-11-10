import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from "pdf-lib";
import sharp from "sharp";
import { createRequire } from "node:module";
import path from "node:path";

const load = createRequire(path.join(process.cwd(), "package.json"));
const { prepareExtractionInput } = load("./src/application/pdf-extraction.ts");

/** Runs inside the production worker image, without credentials or database writes. */
async function main() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [rotation, unit] of [[0, 1], [90, 2], [180, 0.5], [270, 1]]) {
    const page = pdf.addPage([400, 300]);
    page.setCropBox(50, 30, 200, 100);
    page.setRotation(degrees(rotation));
    page.node.set(PDFName.of("UserUnit"), PDFNumber.of(unit));
    page.drawText("INVOICE253", { x: 70, y: 60, size: 16, font });
  }
  const bytes = await pdf.save();
  const input = await prepareExtractionInput({ format: "pdf", mediaType: "application/pdf", bytes, pageCount: 4 });
  assert.deepEqual(input.pageImages.map(page => [page.width, page.height]), [
    [400, 200], [400, 800], [200, 100], [200, 400],
  ]);
  assert.deepEqual(input.bytes, bytes);
  for (const image of input.pageImages) {
    const data = await sharp(image.bytes).removeAlpha().raw().toBuffer();
    assert.ok(data.some(value => value < 100), "Expected rasterized text ink in the production image");
  }
  console.log("PDF renderer: four rotated CropBox/UserUnit pages and text passed; original bytes unchanged.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
