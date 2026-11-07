import { createServerClient } from "@supabase/ssr";
import { expect, inject } from "vitest";
import type { AppClient, Result } from "@/application/client";
import { administratorWithCompany, assignAiConfigurationFixture } from "../../tests/support/fixtures";
import { testWorker } from "../../tests/support/worker";
import { fixtureFile } from "../../tests/support/files";
import { setOctoberImportFixture } from "../../tests/support/claim-eligibility";
import { uploadSourceFile } from "@/application/source-files";
import { listCompanyDocuments, listExtractionVersions } from "@/application/documents";

export function baseUrl() {
  const value = process.env.IVAT_HTTP_BASE_URL;
  if (!value || new URL(value).hostname !== "127.0.0.1") throw new Error("Run HTTP acceptance through npm run test:http in its isolated worktree");
  return value;
}

/** Native SDK session serialization; no synthesized JWT, browser or test route. */
export async function httpAs(client: AppClient, locale = "en") {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) throw new Error("Real Auth session required");
  const cookies = new Map<string, string>([["NEXT_LOCALE", locale]]);
  const transport = createServerClient(inject("supabaseUrl"), inject("supabaseAnonKey"), {
    cookies: {
      getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
      setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)),
    },
  });
  const installed = await transport.auth.setSession(data.session);
  if (installed.error) throw new Error("Could not serialize the real Auth session");
  return async (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    return fetch(new URL(pathname, baseUrl()), { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  };
}

export function value<T>(result: Result<T, string>): T {
  if (!result.ok) throw new Error(`Application refused fixture: ${result.error}`);
  return result.value;
}

/** Setup uses the existing genuine worker handlers and public user commands. */
export async function reviewedSource() {
  const owner = await administratorWithCompany("HTTP private organization");
  const worker = testWorker();
  value(await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai }));
  const original = fixtureFile("two-invoices.pdf");
  const source = value(await uploadSourceFile(owner.client, worker.jobs, { companyId: owner.companyId, fileName: "http-original.pdf", bytes: original }));
  await setOctoberImportFixture(source.id);
  expect(await worker.runJobs()).toEqual([]);
  const documents = await listCompanyDocuments(owner.client, owner.companyId);
  expect(documents).toHaveLength(2);
  expect(documents.map(document => document.status)).toEqual(["needs_review", "needs_review"]);
  const versions = await listExtractionVersions(owner.client, owner.companyId, documents[0].id);
  expect(versions).toHaveLength(1);
  return { ...owner, source, original, document: documents[0], first: versions[0] };
}

export function inputTag(html: string, name: string) {
  const tag = html.match(new RegExp(`<input\\b(?=[^>]*\\bname="${name}")[^>]*>`))?.[0];
  expect(tag, `SSR input ${name}`).toBeDefined();
  return tag!;
}
