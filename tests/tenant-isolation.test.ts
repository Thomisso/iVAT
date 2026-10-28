import { describe, expect, it } from "vitest";
import { createCompany, enableAiProcessing, getCompany, listMyCompanies } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { listDocuments, listExtractionVersions, reprocessDocument } from "@/application/documents";
import { getSourceFile, listSourceFiles, readSourceFile, retrySplit, uploadSourceFile } from "@/application/source-files";
import { anonymousClient, signedUpUser } from "./support/clients";
import { fixtureFile } from "./support/files";
import { systemClient, testWorker } from "./support/worker";
import { administratorWithCompany, companyDetails } from "./support/fixtures";

describe("tenant isolation", () => {
  it("hides another Organization and its Companies from the application layer", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await signedUpUser("Organization B");

    expect((await listMyOrganizations(b.client)).map((o) => o.name)).toEqual(["Organization B"]);
    expect(await listMyCompanies(b.client)).toEqual([]);
    expect(await getCompany(b.client, a.companyId)).toBeNull();
  });

  it("refuses to create a Company in another Organization", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await signedUpUser("Organization B");

    const result = await createCompany(b.client, { organizationId: a.organizationId, ...companyDetails() });

    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(await listMyCompanies(a.client)).toHaveLength(1);
  });

  it("returns nothing of another Organization to direct queries under the user's identity", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await signedUpUser("Organization B");

    const organizations = await b.client.from("organization").select("id").eq("id", a.organizationId);
    const companies = await b.client.from("company").select("id").eq("organization_id", a.organizationId);
    const memberships = await b.client.from("membership").select("id").eq("organization_id", a.organizationId);
    const filingFrequencies = await b.client
      .from("company_filing_frequency")
      .select("company_id")
      .eq("company_id", a.companyId);

    expect(organizations.data).toEqual([]);
    expect(companies.data).toEqual([]);
    expect(memberships.data).toEqual([]);
    expect(filingFrequencies.data).toEqual([]);
  });

  it("refuses direct modification of another Organization under the user's identity", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await signedUpUser("Organization B");

    const renameOrganization = await b.client.from("organization").update({ name: "Hijacked" }).eq("id", a.organizationId);
    const renameCompany = await b.client.from("company").update({ name: "Hijacked" }).eq("id", a.companyId);
    const deleteCompany = await b.client.from("company").delete().eq("id", a.companyId);
    const joinOrganization = await b.client
      .from("membership")
      .insert({ user_id: b.userId, organization_id: a.organizationId, email: b.email, role: "administrator" });
    const forgeFilingFrequency = await b.client
      .from("company_filing_frequency")
      .insert({
        company_id: a.companyId,
        organization_id: a.organizationId,
        frequency: "quarterly",
        effective_from: "2027-01-01",
      });

    for (const attempt of [renameOrganization, renameCompany, deleteCompany, joinOrganization, forgeFilingFrequency]) {
      expect(attempt.error?.code).toBe("42501");
    }
    expect((await listMyOrganizations(a.client)).map((o) => o.name)).toEqual(["Organization A"]);
    expect((await getCompany(a.client, a.companyId))?.name).toBe("Novák s.r.o.");
    expect((await listMyOrganizations(b.client)).map((o) => o.name)).toEqual(["Organization B"]);
  });

  describe("of Source Files", () => {
    async function organizationWithSourceFile() {
      const a = await administratorWithCompany("Organization A");
      const pdf = fixtureFile("two-invoices.pdf");
      const result = await uploadSourceFile(a.client, testWorker().jobs, { companyId: a.companyId, fileName: "a.pdf", bytes: pdf });
      if (!result.ok) throw new Error(result.error);
      return { ...a, sourceFileId: result.value.id, path: `${a.companyId}/${result.value.id}`, pdf };
    }

    it("hides another Organization's Source Files and their content", async () => {
      const a = await organizationWithSourceFile();
      const b = await signedUpUser("Organization B");

      expect(await listSourceFiles(b.client, a.companyId)).toEqual([]);
      expect(await getSourceFile(b.client, a.companyId, a.sourceFileId)).toBeNull();
      expect(await readSourceFile(b.client, a.companyId, a.sourceFileId)).toBeNull();
    });

    it("refuses to fetch another Organization's file from storage under the user's identity", async () => {
      const a = await organizationWithSourceFile();
      const b = await signedUpUser("Organization B");

      const download = await b.client.storage.from("source-files").download(a.path);
      const signedUrl = await b.client.storage.from("source-files").createSignedUrl(a.path, 60);
      const listing = await b.client.storage.from("source-files").list(a.companyId);
      const rows = await b.client.from("source_file").select("id").eq("company_id", a.companyId);

      expect(download.data).toBeNull();
      expect(signedUrl.data).toBeNull();
      expect(listing.data).toEqual([]);
      expect(rows.data).toEqual([]);
    });

    it("refuses uploads into another Organization's Company", async () => {
      const a = await organizationWithSourceFile();
      const b = await signedUpUser("Organization B");

      const result = await uploadSourceFile(b.client, testWorker().jobs, { companyId: a.companyId, fileName: "b.pdf", bytes: a.pdf });
      const direct = await b.client.storage
        .from("source-files")
        .upload(`${a.companyId}/00000000-0000-4000-8000-000000000000`, a.pdf, { contentType: "application/pdf" });

      expect(result).toEqual({ ok: false, error: "forbidden" });
      expect(direct.error).not.toBeNull();
      expect(await listSourceFiles(a.client, a.companyId)).toHaveLength(1);
    });

    it("refuses direct changes to another Organization's Source Files", async () => {
      const a = await organizationWithSourceFile();
      const b = await signedUpUser("Organization B");

      const rename = await b.client.from("source_file").update({ file_name: "hijacked.pdf" }).eq("id", a.sourceFileId);
      const deleteRow = await b.client.from("source_file").delete().eq("id", a.sourceFileId);
      const removed = await b.client.storage.from("source-files").remove([a.path]);

      expect(rename.error?.code).toBe("42501");
      expect(deleteRow.error?.code).toBe("42501");
      expect(removed.data).toEqual([]);
      expect((await readSourceFile(a.client, a.companyId, a.sourceFileId))?.bytes).toEqual(a.pdf);
    });
  });

  describe("of Documents and Extraction Versions", () => {
    async function organizationWithDocument() {
      const a = await administratorWithCompany("Organization A");
      const worker = testWorker();
      await enableAiProcessing(a.client, worker.jobs, { companyId: a.companyId, provider: worker.ai });
      const uploaded = await uploadSourceFile(a.client, worker.jobs, {
        companyId: a.companyId,
        fileName: "a.png",
        bytes: fixtureFile("receipt.png"),
      });
      if (!uploaded.ok) throw new Error(uploaded.error);
      await worker.runJobs();
      const [document] = await listDocuments(a.client, a.companyId, uploaded.value.id);
      return { ...a, worker, sourceFileId: uploaded.value.id, documentId: document.id };
    }

    it("hides another Organization's Documents and Extraction Versions", async () => {
      const a = await organizationWithDocument();
      const b = await signedUpUser("Organization B");

      const documents = await b.client.from("document").select("id").eq("company_id", a.companyId);
      const versions = await b.client.from("extraction_version").select("id").eq("company_id", a.companyId);

      expect(await listDocuments(b.client, a.companyId, a.sourceFileId)).toEqual([]);
      expect(await listExtractionVersions(b.client, a.companyId, a.documentId)).toEqual([]);
      expect(documents.data).toEqual([]);
      expect(versions.data).toEqual([]);
    });

    it("refuses to reprocess or retry another Organization's work, even through direct calls", async () => {
      const a = await organizationWithDocument();
      const b = await signedUpUser("Organization B");

      const reprocess = await reprocessDocument(b.client, a.worker.jobs, { companyId: a.companyId, documentId: a.documentId });
      const retry = await retrySplit(b.client, a.worker.jobs, { companyId: a.companyId, sourceFileId: a.sourceFileId });
      const directReprocess = await b.client.rpc("reprocess_document", { target_document_id: a.documentId });
      const directRetry = await b.client.rpc("retry_split", { target_source_file_id: a.sourceFileId });

      expect(reprocess).toEqual({ ok: false, error: "forbidden" });
      expect(retry).toEqual({ ok: false, error: "forbidden" });
      expect(directReprocess.error?.code).toBe("42501");
      expect(directRetry.error?.code).toBe("42501");
      expect(a.worker.queued).toEqual([]);
      expect((await listDocuments(a.client, a.companyId, a.sourceFileId))[0].status).toBe("needs_review");
    });

    it("refuses direct writes to Documents and Extraction Versions, even within the user's own Organization", async () => {
      const a = await organizationWithDocument();
      const [version] = await listExtractionVersions(a.client, a.companyId, a.documentId);

      const attempts = [
        await a.client.from("document").update({ status: "needs_review" }).eq("id", a.documentId),
        await a.client.from("document").delete().eq("id", a.documentId),
        await a.client.from("document").insert({
          organization_id: a.organizationId,
          company_id: a.companyId,
          source_file_id: a.sourceFileId,
          first_page: 1,
          last_page: 1,
        }),
        await a.client.from("extraction_version").update({ payload: {} }).eq("id", version.id),
        await a.client.from("extraction_version").delete().eq("id", version.id),
        await a.client.rpc("record_split", { target_source_file_id: a.sourceFileId, source_ranges: [] }),
        await a.client.rpc("record_ai_extraction", {
          target_document_id: a.documentId,
          target_extraction_request_id: "00000000-0000-4000-8000-000000000000",
          provider: "fake",
          model: "forged",
          payload: {},
          findings: [],
        }),
        await a.client.from("source_file").update({ status: "uploaded" }).eq("id", a.sourceFileId),
        await a.client.from("company").update({ name: "Renamed" }).eq("id", a.companyId),
      ];

      for (const attempt of attempts) expect(attempt.error?.code).toBe("42501");
      expect(await listExtractionVersions(a.client, a.companyId, a.documentId)).toEqual([version]);
    });

    it("keeps Extraction Versions immutable even for the worker", async () => {
      const a = await organizationWithDocument();
      const [version] = await listExtractionVersions(a.client, a.companyId, a.documentId);
      const system = systemClient();

      const update = await system.from("extraction_version").update({ payload: {} }).eq("id", version.id);
      const remove = await system.from("extraction_version").delete().eq("id", version.id);

      expect(update.error?.code).toBe("42501");
      expect(remove.error?.code).toBe("42501");
      expect(await listExtractionVersions(a.client, a.companyId, a.documentId)).toEqual([version]);
    });
  });

  it("gives an anonymous visitor no access to tenant data", async () => {
    const a = await administratorWithCompany("Organization A");
    const anonymous = anonymousClient();

    const companies = await anonymous.from("company").select("id").eq("id", a.companyId);

    expect(companies.error?.code).toBe("42501");
  });
});
