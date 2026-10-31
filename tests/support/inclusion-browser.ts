import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { asUserClient } from "@/application/client";
import { createCompany } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { approveDocument, createManualDocument } from "@/application/documents";
import { provisionAccountFixture } from "./accounts";
import { setLegacyDocumentApprovedFixture } from "./legacy-document-approval";
import { SYNTHETIC_EXCLUDED_PURCHASE } from "./truthful-inclusion";

export async function inclusionBrowserFixture() {
  const environment = Object.fromEntries((await fs.readFile(".env.local", "utf8")).split("\n").filter(Boolean).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const service = createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SECRET_KEY, options);
  const client = asUserClient(createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, options));
  const email = `inclusion-${crypto.randomUUID()}@example.test`;
  const password = "Truthful-inclusion-password-172";
  await provisionAccountFixture(service, { email, password, organizationName: "Synthetic reporting checks" });
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  const [organization] = await listMyOrganizations(client);
  const company = await createCompany(client, {
    organizationId: organization.id, name: "Synthetic reporting checks", ico: "27082440", vatId: "CZ27082440", personType: "legal",
    streetName: "Říční", houseNumber: "12", city: "Brno", postalCode: "60200", filingFrequency: "monthly", reportingYear: 2026,
  });
  if (!company.ok) throw new Error(company.error);
  const companyId = company.value.id;
  const excluded = await createManualDocument(client, { companyId, payload: SYNTHETIC_EXCLUDED_PURCHASE });
  if (!excluded.ok) throw new Error(excluded.error);
  await setLegacyDocumentApprovedFixture(environment.DATABASE_URL, excluded.value.id, [{ field: "payment.bankAccount", severity: "warning", code: "missing_bank_account" }]);
  const included = await createManualDocument(client, { companyId, payload: {
    ...SYNTHETIC_EXCLUDED_PURCHASE, documentNumber: "SYNTHETIC-INCLUDED-ADVISORY",
    supplier: { ...SYNTHETIC_EXCLUDED_PURCHASE.supplier, vatId: "CZ27082440" },
  } }, undefined, { async check() { return { outcome: "checked", unreliable: false, publishedAccounts: [] }; } });
  if (!included.ok) throw new Error(included.error);
  const approved = await approveDocument(client, { companyId, documentId: included.value.id, version: 1 });
  if (!approved.ok) throw new Error(approved.error);
  return { companyId, email, password, excludedId: excluded.value.id, includedId: included.value.id };
}
