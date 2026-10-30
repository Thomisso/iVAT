import { Client as DatabaseClient } from "pg";
import type { ExtractionPayload } from "@/application/extraction-payload";

/** Inserts an older-shape immutable Version, bypassing only today's preparation normalization. */
export async function addLegacyRateBreakdownVersionFixture(databaseUrl: string, documentId: string): Promise<number> {
  const database = new DatabaseClient({ connectionString: databaseUrl });
  await database.connect();
  try {
    const current = await database.query("select * from public.extraction_version where document_id = $1 order by version desc limit 1", [documentId]);
    const saved = current.rows[0];
    if (!saved) throw new Error("Missing fixture Extraction Version");
    const payload: ExtractionPayload = {
      ...saved.payload,
      documentType: "credit_note", originalDocumentNumber: "FV-ORIGINAL", currency: "EUR", direction: "incoming",
      proposedVatRegime: "domestic_reverse_charge", reverseChargeCode: "4",
      rateBreakdown: [
        { rate: 0, netAmount: "0.00", vatAmount: "0.00" },
        { rate: 12, netAmount: "-50.00", vatAmount: "0.00" },
        { rate: 21, netAmount: "-100.00", vatAmount: "-20.00" },
      ],
      totals: { netAmount: "-150.00", vatAmount: "-20.00", grossAmount: "-170.00" },
      confidence: { "rateBreakdown.1.netAmount": 0.62, "rateBreakdown.2.vatAmount": 0.45 },
      czkConversion: { originalCurrency: "EUR", rate: "25.00", unit: 1, rateDate: saved.payload.taxPointDate, source: "CNB",
        rateBreakdown: [
          { rate: 0, netAmount: "0.00", vatAmount: "0.00" },
          { rate: 12, netAmount: "-1250.00", vatAmount: "0.00" },
          { rate: 21, netAmount: "-2500.00", vatAmount: "-500.00" },
        ], totals: { netAmount: "-3750.00", vatAmount: "-500.00", grossAmount: "-4250.00" },
      },
    };
    await database.query(`insert into public.extraction_version
      (organization_id, company_id, document_id, version, payload, findings, provider, model, extraction_request_id)
      values ($1, $2, $3, $4, $5, $6, 'fake', 'legacy', gen_random_uuid())`, [saved.organization_id, saved.company_id, documentId, saved.version + 1, payload,
      JSON.stringify([{ field: "rateBreakdown.2.vatAmount", severity: "error", code: "rate_vat_amount_mismatch" }])]);
    return saved.version + 1;
  } finally {
    await database.end();
  }
}
