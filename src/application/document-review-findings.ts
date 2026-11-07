import type { AppClient, Result } from "./client";
import type { ExtractionPayload } from "./extraction-payload";
import type { ValidationFinding } from "./document-validation";
import { getDocumentBankAccountChecks } from "./bank-account-checks";

/** One authoritative projection for new Versions and the current-view warnings. */
export async function prepareDocumentCounterparty(client: AppClient, companyId: string, documentId: string | null, payload: ExtractionPayload): Promise<Result<{ payload: ExtractionPayload; findings: ValidationFinding[] }, "forbidden">> {
  const { data, error } = await client.rpc("prepare_document_counterparty", { target_company_id: companyId, target_document_id: documentId!, candidate: payload });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error) throw error;
  return { ok: true, value: data as unknown as { payload: ExtractionPayload; findings: ValidationFinding[] } };
}

export async function getCurrentDocumentReviewFindings(client: AppClient, input: { companyId: string; documentId: string }) {
  const observations = await getDocumentBankAccountChecks(client, input);
  const directory = observations.payload ? await prepareDocumentCounterparty(client, input.companyId, input.documentId, observations.payload) : null;
  const counterparty = directory?.ok ? directory.value.payload.counterpartyLink ?? null : null;
  const findings = [...observations.findings.filter(f => f.code !== "counterparty_directory_difference"), ...(directory?.ok ? directory.value.findings : [])];
  const displayedReviewContext = JSON.stringify({ version: observations.extractionVersionId, bankCheck: observations.current?.id ?? null, counterparty });
  return { ...observations, findings, counterparty, displayedReviewContext };
}
