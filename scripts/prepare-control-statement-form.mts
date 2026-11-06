/** Offline preparation only. Runtime uses the committed, cleaned static artwork. */
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream, degrees } from "pdf-lib";
const source = await PDFDocument.load(await readFile("docs/PDF/Vzorovy-formular-kontrolniho-hlaseni-DPH.pdf"));
if (source.getPageCount() !== 8) throw new Error("Unexpected Control Statement reference");
for (const page of source.getPages()) {
  const contents = page.node.get(PDFName.of("Contents"));
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  const content = streams.map(ref => {
    const stream = source.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) throw new Error("Unexpected reference content");
    return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
  }).join("\n");
  if ((content.match(/\/Fm1 Do/g) ?? []).length !== 1) throw new Error("Unexpected watermark invocation");
  // Keep the complete graphics-state block: its leading Q also closes form
  // artwork state on several landscape pages. Only the watermark Do is removed.
  page.node.set(PDFName.of("Contents"), source.context.register(source.context.flateStream(content.replace("/Fm1 Do", ""))));
}
const clean = await PDFDocument.create();
for (const index of [0, 1, 2, 4, 5, 6, 7]) {
  const original = source.getPage(index);
  if (original.getRotation().angle === 270) {
    const embedded = await clean.embedPage(original);
    const { width, height } = original.getSize();
    clean.addPage([height, width]).drawPage(embedded, { x: height, y: 0, width, height, rotate: degrees(90) });
  } else {
    const [page] = await clean.copyPages(source, [index]);
    clean.addPage(page);
  }
}
clean.setTitle("Kontrolní hlášení DPHKH1 - čistý zelený formulář");
await writeFile("assets/pdf/control-statement.pdf", await clean.save());
