import { describe, expect, it } from "vitest";
import { createCompany } from "@/application/companies";
import { getSourceFile, listSourceFiles, readSourceFile, uploadSourceFile } from "@/application/source-files";
import { administratorWithCompany, companyDetails } from "./support/fixtures";
import { fixtureFile } from "./support/files";

describe("Source File upload", () => {
  it("stores a PDF unchanged and lists it with its hash, format and page count", async () => {
    const { client, companyId } = await administratorWithCompany();
    const pdf = fixtureFile("two-invoices.pdf");

    const result = await uploadSourceFile(client, { companyId, fileName: "two-invoices.pdf", bytes: pdf });

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
        pageCount: 2,
        uploadedAt: expect.any(String),
      },
    ]);
    const stored = await readSourceFile(client, companyId, result.value.id);
    expect(stored?.bytes).toEqual(pdf);
  });

  it.each([
    ["receipt.png", "receipt.png", "png", "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77"],
    ["receipt.jpg", "receipt.jpg", "jpeg", "9650f149d622055c4b495e65e9148ebfc5e61b1bb00e83538e76afe48c496eaf"],
    ["receipt.jpg", "Receipt.JPEG", "jpeg", "9650f149d622055c4b495e65e9148ebfc5e61b1bb00e83538e76afe48c496eaf"],
  ])("stores the image %s uploaded as %s as a one-page Source File", async (fixture, fileName, format, sha256) => {
    const { client, companyId } = await administratorWithCompany();
    const image = fixtureFile(fixture);

    const result = await uploadSourceFile(client, { companyId, fileName, bytes: image });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await listSourceFiles(client, companyId)).toEqual([
      expect.objectContaining({ id: result.value.id, fileName, format, sha256, pageCount: 1 }),
    ]);
    expect((await readSourceFile(client, companyId, result.value.id))?.bytes).toEqual(image);
  });

  it.each([
    ["an unsupported extension", "invoices.xlsx", fixtureFile("two-invoices.pdf"), "unsupported_format"],
    ["no extension", "invoice", fixtureFile("two-invoices.pdf"), "unsupported_format"],
    ["content that does not match the extension", "receipt.jpg", fixtureFile("receipt.png"), "content_does_not_match_format"],
    ["a PDF that cannot be read", "invoice.pdf", new TextEncoder().encode("%PDF-1.7\nnot really a PDF"), "unreadable_file"],
    ["an empty file", "invoice.pdf", new Uint8Array(), "file_required"],
  ])("refuses %s", async (_case, fileName, bytes, error) => {
    const { client, companyId } = await administratorWithCompany();

    const result = await uploadSourceFile(client, { companyId, fileName, bytes });

    expect(result).toEqual({ ok: false, error });
    expect(await listSourceFiles(client, companyId)).toEqual([]);
  });

  it("lists the Company's Source Files newest first", async () => {
    const { client, companyId } = await administratorWithCompany();
    await uploadSourceFile(client, { companyId, fileName: "first.png", bytes: fixtureFile("receipt.png") });
    await uploadSourceFile(client, { companyId, fileName: "second.pdf", bytes: fixtureFile("two-invoices.pdf") });

    const files = await listSourceFiles(client, companyId);

    expect(files.map((f) => f.fileName)).toEqual(["second.pdf", "first.png"]);
  });
});

describe("a stored Source File", () => {
  it("cannot be overwritten, changed or deleted by its uploader, even through direct queries", async () => {
    const { client, companyId } = await administratorWithCompany();
    const pdf = fixtureFile("two-invoices.pdf");
    const result = await uploadSourceFile(client, { companyId, fileName: "two-invoices.pdf", bytes: pdf });
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
    const result = await uploadSourceFile(client, { companyId, fileName: "a.png", bytes: fixtureFile("receipt.png") });
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
});
