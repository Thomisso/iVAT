/** Offline preparation only. Keep the original reference untouched: its two
 * isolated Form XObjects are the artwork; the page stream is specimen data. */
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";

const document = await PDFDocument.load(await readFile("docs/PDF/DPHDP3-XXXXXXXXXX-20261106-104851.pdf"));
if (document.getPageCount() !== 2) throw new Error("Unexpected VAT Return reference");
for (const [index, page] of document.getPages().entries()) {
  const name = `Xf${index + 1}`;
  const objects = page.node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
  if (!objects?.has(PDFName.of(name))) throw new Error(`Missing ${name} artwork`);
  page.node.set(PDFName.of("Contents"), document.context.register(document.context.flateStream(`q /${name} Do Q`)));
}
document.setTitle("Přiznání k dani z přidané hodnoty - čistá předloha");
await writeFile("assets/pdf/vat-return.pdf", await document.save());
