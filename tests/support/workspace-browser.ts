import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { asUserClient } from "@/application/client";
import { listMyOrganizations } from "@/application/organizations";
import { listCompanyDocuments, returnDocumentToReview } from "@/application/documents";
import { controlStatementBrowserFixture } from "./control-statement-browser";

/** Actual saved reporting data plus an AI-authored Document awaiting human confirmation. */
export async function workspaceBrowserFixture() {
  const fixture = await controlStatementBrowserFixture();
  const env = Object.fromEntries((await fs.readFile(".env.local", "utf8")).split("\n").filter(Boolean).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const client = asUserClient(createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }));
  const signedIn = await client.auth.signInWithPassword({ email: fixture.email, password: fixture.password });
  if (signedIn.error) throw signedIn.error;
  const organization = (await listMyOrganizations(client))[0];
  const document = (await listCompanyDocuments(client, fixture.companyId))[0];
  const returned = await returnDocumentToReview(client, { companyId: fixture.companyId, documentId: document.id });
  if (!returned.ok) throw new Error(returned.error);
  return { ...fixture, organizationId: organization.id, documentId: document.id, client };
}
