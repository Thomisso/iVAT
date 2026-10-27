// Seeds the local stack with a fresh QA account to look at the app with: an
// Organization, a Company with AI processing enabled, and a two-Document PDF
// uploaded to it. The worker (`npm run worker`) Splits and Extracts it.
//
//   npm run dev:seed [-- --base-url http://localhost:3100]
//
// Each run creates a new account, so it never touches anyone's existing data.
// It prints the sign-in details, the URLs, and a Cookie header for HTTP clients.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { signUp } from "@/application/auth";
import { asUserClient } from "@/application/client";
import { createCompany, enableAiProcessing } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { uploadSourceFile } from "@/application/source-files";
import { configuredAiProvider } from "@/ai";
import type { Database } from "@/lib/database.types";
import { supabasePublishableKey, supabaseUrl } from "@/lib/env";
import { jobQueue } from "@/lib/jobs";

const FIXTURE = path.join(__dirname, "..", "tests", "fixtures", "two-invoices.pdf");

function baseUrl(): string {
  const flag = process.argv.indexOf("--base-url");
  return flag === -1 ? "http://localhost:3000" : process.argv[flag + 1];
}

/** The cookie @supabase/ssr reads the session from, for HTTP clients that cannot sign in through the form. */
function sessionCookie(session: unknown): string {
  const ref = new URL(supabaseUrl).hostname.split(".")[0];
  return `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

async function main() {
  const client = asUserClient(
    createClient<Database>(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false } }),
  );
  const email = `qa-${Date.now()}@example.test`;
  const password = randomBytes(12).toString("base64url");

  const signedUp = await signUp(client, { email, password, organizationName: "QA Organization" });
  if (!signedUp.ok) throw new Error(`Sign-up failed: ${signedUp.error}`);
  const [organization] = await listMyOrganizations(client);
  const company = await createCompany(client, {
    organizationId: organization.id,
    name: "QA s.r.o.",
    ico: "27082440",
    vatId: "CZ27082440",
    street: "Na Příkopě 1",
    city: "Praha",
    postalCode: "110 00",
  });
  if (!company.ok) throw new Error(`Company creation failed: ${company.error}`);
  const companyId = company.value.id;
  const enabled = await enableAiProcessing(client, jobQueue, { companyId, provider: configuredAiProvider() });
  if (!enabled.ok) throw new Error(`Enabling AI processing failed: ${enabled.error}`);
  const uploaded = await uploadSourceFile(client, jobQueue, {
    companyId,
    fileName: "two-invoices.pdf",
    bytes: new Uint8Array(fs.readFileSync(FIXTURE)),
  });
  if (!uploaded.ok) throw new Error(`Upload failed: ${uploaded.error}`);

  const { data } = await client.auth.getSession();
  const url = baseUrl();
  console.log(`Email:       ${email}`);
  console.log(`Password:    ${password}`);
  console.log(`Sign in:     ${url}/login`);
  console.log(`Company:     ${url}/companies/${companyId}`);
  console.log(`Source File: ${url}/companies/${companyId}/source-files/${uploaded.value.id}`);
  console.log(`Cookie:      ${sessionCookie(data.session)}`);
  console.log("Its Documents appear for review once `npm run worker` has processed the Source File.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
