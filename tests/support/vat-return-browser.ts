import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { asUserClient } from "@/application/client";
import { createCompany } from "@/application/companies";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { listMyOrganizations } from "@/application/organizations";
import { approveDocument, createManualDocument } from "@/application/documents";
import { generateVatReport } from "@/application/vat-reports";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { provisionAccountFixture } from "./accounts";

/** Browser fixture uses real Auth, approved data and a saved report. */
export async function vatReturnBrowserFixture() {
  const environment = Object.fromEntries((await fs.readFile(".env.local", "utf8")).split("\n").filter(Boolean).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const service = createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SECRET_KEY, options);
  const client = asUserClient(createClient<Database>(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, options));
  const email = `vat-form-${crypto.randomUUID()}@example.test`;
  const password = "Vat-form-password-213";
  await provisionAccountFixture(service, { email, password, organizationName: "Přiznání PDF" });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  const [organization] = await listMyOrganizations(client);
  const company = await createCompany(client, { organizationId: organization.id, name: "Příliš žluťoučký kůň s.r.o.", personType: "legal", ico: "27082440", vatId: "CZ27082440", streetName: "Říční", houseNumber: "12", orientationNumber: "3A", city: "Brno", postalCode: "60200", filingFrequency: "monthly", reportingYear: 2026 });
  if (!company.ok) throw new Error(company.error);
  const companyId = company.value.id;
  const defaults = await saveCompanyFilingDefaults(client, { companyId, taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka", email: "default@example.test", phone: "+420123456789", epoAddressOverride: null });
  if (!defaults.ok) throw new Error(defaults.error);
  const created = await createManualDocument(client, { companyId, payload: { ...SAMPLE_EXTRACTION, rateBreakdown: [{ rate: 21, netAmount: "1002.50", vatAmount: "210.53" }], totals: { netAmount: "1002.50", vatAmount: "210.53", grossAmount: "1213.03" } } });
  if (!created.ok) throw new Error(created.error);
  const approved = await approveDocument(client, { companyId, documentId: created.value.id, version: 1 });
  if (!approved.ok) throw new Error(approved.error);
  const generated = await generateVatReport(client, { companyId, period: "2026-10" });
  if (!generated.ok) throw new Error(generated.error);
  return { companyId, email, password };
}
