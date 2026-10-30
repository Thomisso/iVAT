import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import type { Database } from "@/lib/database.types";
import { asUserClient } from "@/application/client";
import { createCompany } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { uploadSourceFile } from "@/application/source-files";
import { approveDocument } from "@/application/documents";
import { generateVatReport } from "@/application/vat-reports";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { provisionAccountFixture } from "./accounts";
import { assignBrowserAiConfigurationFixture } from "./e2e";

/** Real approved Documents and Rules Engine snapshot; no report rows are mocked. */
export async function controlStatementBrowserFixture() {
  const environment = Object.fromEntries((await fs.readFile(".env.local", "utf8")).split("\n").filter(Boolean).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const service = createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SECRET_KEY, options);
  const client = asUserClient(createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, options));
  const email = `control-groups-${crypto.randomUUID()}@example.test`;
  const password = "Control-statement-password-173";
  await provisionAccountFixture(service, { email, password, organizationName: "Control Statement groups" });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  const [organization] = await listMyOrganizations(client);
  const created = await createCompany(client, {
    organizationId: organization.id, name: "Control Statement groups", ico: "27082440", vatId: "CZ27082440", personType: "legal",
    streetName: "Říční", houseNumber: "12", orientationNumber: "", city: "Brno", postalCode: "60200", filingFrequency: "monthly", reportingYear: 2026,
  });
  if (!created.ok) throw new Error(created.error);
  const companyId = created.value.id;
  await assignBrowserAiConfigurationFixture(companyId);
  const cases = [
    ["GROUP-A4-ONE", "outgoing", "10000.00", "2100.00", "12100.00"],
    ["GROUP-A4-TWO", "outgoing", "20000.00", "4200.00", "24200.00"],
    ["GROUP-A5", "outgoing", "200.00", "42.00", "242.00"],
    ["GROUP-B3-ONE", "incoming", "1000.00", "210.00", "1210.00"],
    ["GROUP-B3-TWO", "incoming", "1000.00", "210.00", "1210.00"],
  ] as const;
  const pdf = await PDFDocument.create();
  for (let index = 0; index < cases.length; index++) pdf.addPage();
  const uploaded = await uploadSourceFile(client, { async send() {} }, { companyId, fileName: "grouped-statements.pdf", bytes: await pdf.save() });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const split = await service.rpc("record_split", { target_source_file_id: uploaded.value.id, source_ranges: cases.map((_, index) => ({ firstPage: index + 1, lastPage: index + 1 })) });
  if (split.error) throw split.error;
  const documents = await service.from("document").select("id, extraction_request_id").eq("company_id", companyId).order("first_page");
  if (documents.error) throw documents.error;
  for (const [index, document] of documents.data.entries()) {
    const [documentNumber, direction, netAmount, vatAmount, grossAmount] = cases[index];
    const reservationId = crypto.randomUUID();
    const reserved = await service.rpc("reserve_ai_processing", { target_document_id: document.id, target_extraction_request_id: document.extraction_request_id, target_reservation_id: reservationId });
    if (reserved.error || reserved.data !== "reserved") throw new Error("Could not reserve grouping fixture");
    const recorded = await service.rpc("record_ai_extraction", {
      target_document_id: document.id, target_extraction_request_id: document.extraction_request_id, target_reservation_id: reservationId,
      provider: "fake", model: "fake-extract", findings: [],
      payload: { ...SAMPLE_EXTRACTION, documentNumber, direction, taxPointDate: "2026-10-10", rateBreakdown: [{ rate: 21, netAmount, vatAmount }], totals: { netAmount, vatAmount, grossAmount } },
    });
    if (recorded.error) throw recorded.error;
    const approved = await approveDocument(client, { companyId, documentId: document.id, version: 1 });
    if (!approved.ok) throw new Error(approved.error);
  }
  const generated = await generateVatReport(client, { companyId, period: "2026-10" });
  if (!generated.ok) throw new Error(generated.error);
  return { companyId, email, password };
}
