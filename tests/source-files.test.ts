import { describe, expect, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import { createCompany } from "@/application/companies";
import {
  getSourceFile,
  listSourceFiles,
  readSourceFile,
  readSourceFileDerivative,
  uploadSourceFile,
} from "@/application/source-files";
import { administratorWithCompany, companyDetails } from "./support/fixtures";
import { fixtureFile, heicFixture, rotatedHeicFixture, workbookFile } from "./support/files";
import { testWorker } from "./support/worker";

describe("Source File upload", () => {
  it("stores a PDF unchanged and lists it with its hash, format and page count", async () => {
    const { client, companyId } = await administratorWithCompany();
    const pdf = fixtureFile("two-invoices.pdf");

    const result = await uploadSourceFile(client, testWorker().jobs, { companyId, fileName: "two-invoices.pdf", bytes: pdf });

    expect(result).toEqual({ ok: true, value: { id: expect.any(String) } });
    if (!result.ok) return;
    expect(await listSourceFiles(client, companyId)).toEqual([
      {
        id: result.value.id,
        companyId,
        fileName: "two-invoices.pdf",
        format: "pdf",
        byteSize: 1303,
        sha256: "79ae60b6a1040a3eaf64d441f2fa48f627a18d1e5c1ad831ba6919e9e9c663ea",
        normalizedDerivative: null,
        pageCount: 2,
        preselectedDirection: null,
        status: "uploaded",
        uploadedAt: expect.any(String),
      },
    ]);
    const stored = await readSourceFile(client, companyId, result.value.id);
    expect(stored?.bytes).toEqual(pdf);
  });

  it("stores an optional Direction preselection with the Source File", async () => {
    const { client, companyId } = await administratorWithCompany();

    const result = await uploadSourceFile(client, testWorker().jobs, {
      companyId,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
      preselectedDirection: "outgoing",
    });

    expect(result.ok).toBe(true);
    expect(await listSourceFiles(client, companyId)).toEqual([
      expect.objectContaining({ preselectedDirection: "outgoing" }),
    ]);
  });

  it.each([
    ["receipt.png", "receipt.png", "png", "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77"],
    ["receipt.jpg", "receipt.jpg", "jpeg", "9650f149d622055c4b495e65e9148ebfc5e61b1bb00e83538e76afe48c496eaf"],
    ["receipt.jpg", "Receipt.JPEG", "jpeg", "9650f149d622055c4b495e65e9148ebfc5e61b1bb00e83538e76afe48c496eaf"],
  ])("stores the image %s uploaded as %s as a one-page Source File", async (fixture, fileName, format, sha256) => {
    const { client, companyId } = await administratorWithCompany();
    const image = fixtureFile(fixture);

    const result = await uploadSourceFile(client, testWorker().jobs, { companyId, fileName, bytes: image });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await listSourceFiles(client, companyId)).toEqual([
      expect.objectContaining({ id: result.value.id, fileName, format, sha256, pageCount: 1 }),
    ]);
    expect((await readSourceFile(client, companyId, result.value.id))?.bytes).toEqual(image);
  });

  it.each([
    ["receipt.heic", "heic"],
    ["receipt.HEIF", "heif"],
  ] as const)("preserves %s and audit-links its normalized JPEG derivative", async (fileName, format) => {
    const { client, companyId, organizationId } = await administratorWithCompany();
    const original = heicFixture();

    const result = await uploadSourceFile(client, testWorker().jobs, {
      companyId,
      fileName,
      bytes: original,
    });

    expect(result).toEqual({ ok: true, value: { id: expect.any(String) } });
    if (!result.ok) return;
    const [stored] = await listSourceFiles(client, companyId);
    expect(stored).toEqual(expect.objectContaining({
      id: result.value.id,
      format,
      byteSize: 1375,
      sha256: "49df5e1dc3854738e19694e07f8121b04a6f4985e2f502a755cd447235b6e076",
      normalizedDerivative: {
        format: "jpeg",
        byteSize: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    }));
    expect((await readSourceFile(client, companyId, result.value.id))?.bytes).toEqual(original);
    const derivative = await readSourceFileDerivative(client, companyId, result.value.id);
    expect(derivative).toEqual({
      sourceFileId: result.value.id,
      originalSha256: "49df5e1dc3854738e19694e07f8121b04a6f4985e2f502a755cd447235b6e076",
      format: "jpeg",
      sha256: stored.normalizedDerivative?.sha256,
      bytes: expect.any(Uint8Array),
    });
    expect(derivative?.bytes.slice(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect((await listAuditEvents(client, organizationId)).at(-1)).toEqual(expect.objectContaining({
      action: "source_file.uploaded",
      targetId: result.value.id,
      payload: {
        file_name: fileName,
        format,
        byte_size: 1375,
        sha256: "49df5e1dc3854738e19694e07f8121b04a6f4985e2f502a755cd447235b6e076",
        page_count: 1,
        normalized_derivative: {
          format: "jpeg",
          byte_size: stored.normalizedDerivative?.byteSize,
          sha256: stored.normalizedDerivative?.sha256,
        },
      },
    }));
  });

  it("applies HEIF rotation metadata only to the normalized derivative", async () => {
    const { client, companyId } = await administratorWithCompany();
    const original = rotatedHeicFixture();

    const result = await uploadSourceFile(client, testWorker().jobs, {
      companyId,
      fileName: "rotated.heic",
      bytes: original,
    });

    if (!result.ok) throw new Error(result.error);
    const stored = await getSourceFile(client, companyId, result.value.id);
    expect(stored).toEqual(expect.objectContaining({
      sha256: "e10c56139d49bdccbc54838b8f9726a8c0d1474df62b4429b6c7b62d43440953",
      normalizedDerivative: {
        format: "jpeg",
        byteSize: 664,
        sha256: "268da1a5dfca47126246de862aedef33128afaddd56265457d5dea20beffaf22",
      },
    }));
    expect((await readSourceFile(client, companyId, result.value.id))?.bytes).toEqual(original);
  });

  it.each(["xlsx", "xls"] as const)("stores a genuine .%s workbook unchanged", async (format) => {
    const { client, companyId } = await administratorWithCompany();
    const workbook = workbookFile(format, [
      ["Document number", "Issue date", "Gross amount"],
      ["FV-1", new Date("2026-10-01T00:00:00.000Z"), 1210],
    ]);

    const result = await uploadSourceFile(client, testWorker().jobs, {
      companyId,
      fileName: `invoices.${format}`,
      bytes: workbook,
    });

    expect(result).toEqual({ ok: true, value: { id: expect.any(String) } });
    if (!result.ok) return;
    expect(await listSourceFiles(client, companyId)).toEqual([
      expect.objectContaining({ id: result.value.id, format, pageCount: 1 }),
    ]);
    const storedWorkbook = (await readSourceFile(client, companyId, result.value.id))?.bytes;
    expect(storedWorkbook && Buffer.from(storedWorkbook)).toEqual(Buffer.from(workbook));
  });

  it.each([
    ["an unsupported extension", "invoices.csv", fixtureFile("two-invoices.pdf"), "unsupported_format"],
    ["no extension", "invoice", fixtureFile("two-invoices.pdf"), "unsupported_format"],
    ["content that does not match the extension", "receipt.jpg", fixtureFile("receipt.png"), "content_does_not_match_format"],
    ["a PDF that cannot be read", "invoice.pdf", new TextEncoder().encode("%PDF-1.7\nnot really a PDF"), "unreadable_file"],
    ["an empty file", "invoice.pdf", new Uint8Array(), "file_required"],
  ])("refuses %s", async (_case, fileName, bytes, error) => {
    const { client, companyId } = await administratorWithCompany();

    const result = await uploadSourceFile(client, testWorker().jobs, { companyId, fileName, bytes });

    expect(result).toEqual({ ok: false, error });
    expect(await listSourceFiles(client, companyId)).toEqual([]);
  });

  it("refuses a Source File larger than the platform limit", async () => {
    const { client, companyId } = await administratorWithCompany();
    const bytes = new Uint8Array(20 * 1024 * 1024 + 1);
    bytes.set(fixtureFile("receipt.png"));

    const result = await uploadSourceFile(client, testWorker().jobs, {
      companyId,
      fileName: "large.png",
      bytes,
    });

    expect(result).toEqual({ ok: false, error: "file_too_large" });
    expect(await listSourceFiles(client, companyId)).toEqual([]);
  });

  it("refuses a PDF with more pages than the platform limit", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const { client, companyId } = await administratorWithCompany();
    const pdf = await PDFDocument.create();
    for (let page = 0; page < 51; page++) pdf.addPage();

    const result = await uploadSourceFile(client, testWorker().jobs, {
      companyId,
      fileName: "too-many-pages.pdf",
      bytes: await pdf.save(),
    });

    expect(result).toEqual({ ok: false, error: "too_many_pages" });
    expect(await listSourceFiles(client, companyId)).toEqual([]);
  });

  it("lists the Company's Source Files newest first", async () => {
    const { client, companyId } = await administratorWithCompany();
    await uploadSourceFile(client, testWorker().jobs, { companyId, fileName: "first.png", bytes: fixtureFile("receipt.png") });
    await uploadSourceFile(client, testWorker().jobs, { companyId, fileName: "second.pdf", bytes: fixtureFile("two-invoices.pdf") });

    const files = await listSourceFiles(client, companyId);

    expect(files.map((f) => f.fileName)).toEqual(["second.pdf", "first.png"]);
  });
});

describe("a stored Source File", () => {
  it("cannot be overwritten, changed or deleted by its uploader, even through direct queries", async () => {
    const { client, companyId } = await administratorWithCompany();
    const pdf = fixtureFile("two-invoices.pdf");
    const result = await uploadSourceFile(client, testWorker().jobs, { companyId, fileName: "two-invoices.pdf", bytes: pdf });
    if (!result.ok) throw new Error(result.error);
    const before = await listSourceFiles(client, companyId);
    const path = `${companyId}/${result.value.id}`;

    const overwrite = await client.storage
      .from("source-files")
      .upload(path, fixtureFile("receipt.png"), { contentType: "image/png", upsert: true });
    const update = await client.storage.from("source-files").update(path, fixtureFile("receipt.png"), { contentType: "image/png" });
    const removed = await client.storage.from("source-files").remove([path]);
    const rename = await client.from("source_file").update({ file_name: "tampered.pdf" }).eq("id", result.value.id);
    const deleteRow = await client.from("source_file").delete().eq("id", result.value.id);

    expect(overwrite.error).not.toBeNull();
    expect(update.error).not.toBeNull();
    expect(removed.data).toEqual([]);
    expect(rename.error?.code).toBe("42501");
    expect(deleteRow.error?.code).toBe("42501");
    expect(await listSourceFiles(client, companyId)).toEqual(before);
    expect((await readSourceFile(client, companyId, result.value.id))?.bytes).toEqual(pdf);
  });

  it("is found only under its own Company", async () => {
    const { client, organizationId, companyId } = await administratorWithCompany();
    const other = await createCompany(client, { organizationId, ...companyDetails() });
    if (!other.ok) throw new Error(other.error);
    const result = await uploadSourceFile(client, testWorker().jobs, { companyId, fileName: "a.png", bytes: fixtureFile("receipt.png") });
    if (!result.ok) throw new Error(result.error);

    expect(await getSourceFile(client, other.value.id, result.value.id)).toBeNull();
    expect(await readSourceFile(client, other.value.id, result.value.id)).toBeNull();
    expect(await listSourceFiles(client, other.value.id)).toEqual([]);
  });

  it("is not recorded without its stored file", async () => {
    const { client, organizationId, companyId } = await administratorWithCompany();

    const insert = await client.from("source_file").insert({
      id: "00000000-0000-4000-8000-000000000000",
      organization_id: organizationId,
      company_id: companyId,
      file_name: "ghost.pdf",
      format: "pdf",
      byte_size: 1303,
      sha256: "79ae60b6a1040a3eaf64d441f2fa48f627a18d1e5c1ad831ba6919e9e9c663ea",
      page_count: 2,
    });

    expect(insert.error?.code).toBe("42501");
    expect(await listSourceFiles(client, companyId)).toEqual([]);
  });

  it("cannot claim a normalized HEIC derivative that was not stored", async () => {
    const { client, organizationId, companyId } = await administratorWithCompany();
    const id = "00000000-0000-4000-8000-000000000001";
    const original = heicFixture();
    const stored = await client.storage
      .from("source-files")
      .upload(`${companyId}/${id}`, original, { contentType: "image/heic" });
    expect(stored.error).toBeNull();

    const insert = await client.from("source_file").insert({
      id,
      organization_id: organizationId,
      company_id: companyId,
      file_name: "unlinked.heic",
      format: "heic",
      byte_size: original.length,
      sha256: "49df5e1dc3854738e19694e07f8121b04a6f4985e2f502a755cd447235b6e076",
      normalized_format: "jpeg",
      normalized_byte_size: 100,
      normalized_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      page_count: 1,
    });

    expect(insert.error?.code).toBe("42501");
    expect(await listSourceFiles(client, companyId)).toEqual([]);
  });
});
