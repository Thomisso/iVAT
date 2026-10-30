// Seeds the local stack with a fresh QA account to look at the app with: an
// Organization, a Company, and a two-Document PDF uploaded to it. Assign a
// platform AI Configuration in the SuperAdmin UI to process the upload.
//
//   npm run dev:seed [-- --base-url http://localhost:3100]
//
// Each run creates a new account, so it never touches anyone's existing data.
// It prints the sign-in details, the URLs, and a Cookie header for HTTP clients.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { logIn } from "@/application/auth";
import { asUserClient } from "@/application/client";
import { createCompany } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { uploadSourceFile } from "@/application/source-files";
import type { Database } from "@/lib/database.types";
import { supabasePublishableKey, supabaseUrl } from "@/lib/env";
import { jobQueue } from "@/lib/jobs";
import { provisionAccountFixture } from "../tests/support/accounts";

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
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(supabaseUrl).hostname)) {
    throw new Error("QA seed only runs against a local Supabase endpoint");
  }
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) throw new Error("SUPABASE_SECRET_KEY is required for private QA provisioning");
  const client = asUserClient(
    createClient<Database>(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false } }),
  );
  const email = `qa-${Date.now()}@example.test`;
  const password = randomBytes(12).toString("base64url");

  const service = createClient<Database>(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  await provisionAccountFixture(service, { email, password, organizationName: "QA Organization" });
  const loggedIn = await logIn(client, { email, password });
  if (!loggedIn.ok) throw new Error(`QA sign-in failed: ${loggedIn.error}`);
  const [organization] = await listMyOrganizations(client);
  const company = await createCompany(client, {
    organizationId: organization.id,
    name: "QA s.r.o.",
    ico: "27082440",
    vatId: "CZ27082440",
    firstName: "",
    lastName: "",
    streetName: "Na Příkopě",
    houseNumber: "1",
    orientationNumber: "",
    city: "Praha",
    postalCode: "110 00",
    personType: "legal",
    filingFrequency: "monthly",
    reportingYear: 2026,
  });
  if (!company.ok) throw new Error(`Company creation failed: ${company.error}`);
  const companyId = company.value.id;
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
  console.log("Assign an AI Configuration in Platform settings, then the worker can process the Source File.");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
