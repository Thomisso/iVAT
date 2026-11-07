import { PDFDocument, StandardFonts } from "pdf-lib";

/** Worked PDF basis: 600×800 points; field rectangles are independently specified in the browser scenario. */
export async function sourceEvidencePdfFixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const label of ["FIRST DOCUMENT", "PDF-EVIDENCE", "PDF-EVIDENCE"]) {
    const page = pdf.addPage([600, 800]);
    const repeated = pdf.getPageCount() === 3;
    page.drawText(label, { x: repeated ? 120 : 60, y: repeated ? 610 : 690, size: 20, font });
    page.drawText("210.00", { x: 420, y: 300, size: 20, font });
  }
  return pdf.save();
}
