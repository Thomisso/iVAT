import { describe, expect, it } from "vitest";
import { createCompany, getCompany, listMyCompanies } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import {
  listDocuments,
  listExtractionVersions,
  reprocessDocument,
  updateDocumentReporting,
} from "@/application/documents";
import { getSourceFile, listSourceFiles, readSourceFile, retrySplit, uploadSourceFile } from "@/application/source-files";
import { anonymousClient, provisionedUser } from "./support/clients";
import { fixtureFile } from "./support/files";
import { systemClient, testWorker } from "./support/worker";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
  companyDetails,
} from "./support/fixtures";

describe("tenant isolation", () => {
  it("refuses Company discovery to an anonymous caller", async () => {
    await expect(listMyCompanies(anonymousClient())).rejects.toMatchObject({ code: "42501" });
  });

  it("hides another Organization and its Companies from the application layer", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await provisionedUser("Organization B");

    expect((await listMyOrganizations(b.client)).map((o) => o.name)).toEqual(["Organization B"]);
    expect(await listMyCompanies(b.client)).toEqual([]);
    expect(await getCompany(b.client, a.companyId)).toBeNull();
  });

  it("refuses to create a Company in another Organization", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await provisionedUser("Organization B");

    const result = await createCompany(b.client, { organizationId: a.organizationId, ...companyDetails() });

    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(await listMyCompanies(a.client)).toHaveLength(1);
  });

  it("returns nothing of another Organization to direct queries under the user's identity", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await provisionedUser("Organization B");

    const organizations = await b.client.from("organization").select("id").eq("id", a.organizationId);
    const companies = await b.client.from("company").select("id").eq("organization_id", a.organizationId);
    const memberships = await b.client.from("membership").select("id").eq("organization_id", a.organizationId);
    const reportingYears = await b.client
      .from("reporting_year")
      .select("company_id")
      .eq("company_id", a.companyId);

    expect(organizations.data).toEqual([]);
    expect(companies.data).toEqual([]);
    expect(memberships.data).toEqual([]);
    expect(reportingYears.data).toEqual([]);
  });

  it("refuses direct modification of another Organization under the user's identity", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await provisionedUser("Organization B");

    const renameOrganization = await b.client.from("organization").update({ name: "Hijacked" }).eq("id", a.organizationId);
    const renameCompany = await b.client.from("company").update({ name: "Hijacked" }).eq("id", a.companyId);
    const deleteCompany = await b.client.from("company").delete().eq("id", a.companyId);
    const joinOrganization = await b.client
      .from("membership")
      .insert({ user_id: b.userId, organization_id: a.organizationId, email: b.email, role: "administrator" });
    const forgeReportingYear = await b.client
      .from("reporting_year")
      .insert({
        company_id: a.companyId,
        organization_id: a.organizationId,
        year: 2027,
        frequency: "quarterly",
      });

    for (const attempt of [renameOrganization, renameCompany, deleteCompany, joinOrganization, forgeReportingYear]) {
      expect(attempt.error?.code).toBe("42501");
    }
    expect((await listMyOrganizations(a.client)).map((o) => o.name)).toEqual(["Organization A"]);
    expect((await getCompany(a.client, a.companyId))?.name).toBe("Novák s.r.o.");
    expect((await listMyOrganizations(b.client)).map((o) => o.name)).toEqual(["Organization B"]);
  });

  it("refuses cross-Organization reads and writes to AI Processing issues", async () => {
    const a = await administratorWithCompany("Issue Organization A");
    const uploaded = await uploadSourceFile(a.client, testWorker().jobs, {
      companyId: a.companyId,
      fileName: "platform-wait.png",
      bytes: fixtureFile("receipt.png"),
    });
    if (!uploaded.ok) throw new Error(uploaded.error);
    const system = systemClient();
    const recorded = await system.rpc("record_ai_processing_issue", {
      target_kind: "source_file",
      target_id: uploaded.value.id,
      target_classification: "invalid_credentials",
      target_state: "waiting_for_platform",
      target_provider: "anthropic",
    });
    if (recorded.error) throw recorded.error;

    const b = await provisionedUser("Issue Organization B");
    const read = await b.client.from("ai_processing_issue").select("target_id").eq("organization_id", a.organizationId);
    const update = await b.client
      .from("ai_processing_issue")
      .update({ classification: "processing_failed" })
      .eq("target_id", uploaded.value.id);
    const remove = await b.client.from("ai_processing_issue").delete().eq("target_id", uploaded.value.id);
    const insert = await b.client.from("ai_processing_issue").insert({
      target_kind: "source_file",
      target_id: crypto.randomUUID(),
      organization_id: a.organizationId,
      company_id: a.companyId,
      classification: "invalid_credentials",
      state: "waiting_for_platform",
    });

    for (const attempt of [read, update, remove, insert]) expect(attempt.error?.code).toBe("42501");
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
      const b = await provisionedUser("Organization B");

      expect(await listSourceFiles(b.client, a.companyId)).toEqual([]);
      expect(await getSourceFile(b.client, a.companyId, a.sourceFileId)).toBeNull();
      expect(await readSourceFile(b.client, a.companyId, a.sourceFileId)).toBeNull();
    });

    it("refuses to fetch another Organization's file from storage under the user's identity", async () => {
      const a = await organizationWithSourceFile();
      const b = await provisionedUser("Organization B");

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
      const b = await provisionedUser("Organization B");

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
      const b = await provisionedUser("Organization B");

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
      const b = await provisionedUser("Organization B");

      const documents = await b.client.from("document").select("id").eq("company_id", a.companyId);
      const versions = await b.client.from("extraction_version").select("id").eq("company_id", a.companyId);

      expect(await listDocuments(b.client, a.companyId, a.sourceFileId)).toEqual([]);
      expect(await listExtractionVersions(b.client, a.companyId, a.documentId)).toEqual([]);
      expect(documents.data).toEqual([]);
      expect(versions.data).toEqual([]);
    });

    it("refuses to reprocess or retry another Organization's work, even through direct calls", async () => {
      const a = await organizationWithDocument();
      const b = await provisionedUser("Organization B");

      const reprocess = await reprocessDocument(b.client, a.worker.jobs, { companyId: a.companyId, documentId: a.documentId });
      const retry = await retrySplit(b.client, a.worker.jobs, { companyId: a.companyId, sourceFileId: a.sourceFileId });
      const directReprocess = await b.client.rpc("reprocess_document", { target_document_id: a.documentId });
      const directRetry = await b.client.rpc("retry_split", { target_source_file_id: a.sourceFileId });
      const reporting = await updateDocumentReporting(b.client, {
        companyId: a.companyId,
        documentId: a.documentId,
        claimedReportingPeriod: null,
      });
      const directReporting = await b.client.rpc("update_document_reporting", {
        target_document_id: a.documentId,
        new_claimed_reporting_period: null as unknown as string,
      });

      expect(reprocess).toEqual({ ok: false, error: "forbidden" });
      expect(retry).toEqual({ ok: false, error: "forbidden" });
      expect(directReprocess.error?.code).toBe("42501");
      expect(directRetry.error?.code).toBe("42501");
      expect(reporting).toEqual({ ok: false, error: "forbidden" });
      expect(directReporting.error?.code).toBe("42501");
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
          target_reservation_id: "00000000-0000-4000-8000-000000000001",
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

    it("refuses cross-Organization reads and writes to AI Processing reservations", async () => {
      const a = await administratorWithCompany("Reservation Organization A");
      const worker = testWorker();
      await enableAiProcessing(a.client, worker.jobs, { companyId: a.companyId, provider: worker.ai });
      const uploaded = await uploadSourceFile(a.client, worker.jobs, {
        companyId: a.companyId,
        fileName: "reserved.png",
        bytes: fixtureFile("receipt.png"),
      });
      if (!uploaded.ok) throw new Error(uploaded.error);
      await worker.runNextJob();
      const [document] = await listDocuments(a.client, a.companyId, uploaded.value.id);
      const system = systemClient();
      const source = await system
        .from("document")
        .select("extraction_request_id")
        .eq("id", document.id)
        .single();
      if (source.error) throw source.error;
      const reservationId = crypto.randomUUID();
      const reservation = await system.rpc("reserve_ai_processing", {
        target_document_id: document.id,
        target_extraction_request_id: source.data.extraction_request_id,
        target_reservation_id: reservationId,
      });
      if (reservation.error) throw reservation.error;
      expect(reservation.data).toBe("reserved");

      const b = await provisionedUser("Reservation Organization B");
      const read = await b.client.from("ai_processing_reservation").select("id").eq("id", reservationId);
      const update = await b.client
        .from("ai_processing_reservation")
        .update({ company_id: a.companyId })
        .eq("id", reservationId);
      const remove = await b.client.from("ai_processing_reservation").delete().eq("id", reservationId);
      const insert = await b.client.from("ai_processing_reservation").insert({
        id: crypto.randomUUID(),
        extraction_request_id: crypto.randomUUID(),
        document_id: document.id,
        organization_id: a.organizationId,
        company_id: a.companyId,
      });

      for (const attempt of [read, update, remove, insert]) expect(attempt.error?.code).toBe("42501");
      expect((await system.rpc("release_ai_processing_reservation", { target_reservation_id: reservationId })).error)
        .toBeNull();
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

it.each(["document_overview", "vat_report_document"] as const)(
  "closes the %s view to anonymous and system clients",
  async (view) => {
    const anonymous = await anonymousClient().from(view).select("id").limit(1);
    const system = await systemClient().from(view).select("id").limit(1);

    expect(anonymous.error?.code).toBe("42501");
    expect(system.error?.code).toBe("42501");
  },
);
