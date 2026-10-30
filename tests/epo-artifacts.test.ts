import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, inject, it } from "vitest";
import {
  exportVatReport,
  listVatReportArtifacts,
  readVatReportArtifact,
  type EpoDownload,
  type VatReportArtifact,
} from "@/application/epo-export";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { finalizeVatReport, generateVatReport } from "@/application/vat-reports";
import { listAuditEvents } from "@/application/audit";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { provisionedUser } from "./support/clients";

const details = {
  preparedOn: "2026-10-27",
};

async function preparedCompany() {
  const company = await administratorWithCompany();
  expect(await saveCompanyFilingDefaults(company.client, {
    companyId: company.companyId,
    taxOffice: "451",
    territorialOffice: "2003",
    economicActivity: "621000",
    signatoryFirstName: "Jana",
    signatoryLastName: "Nováková",
    signatoryCapacity: "jednatelka",
    email: "podatelna@example.test",
    phone: "+420123456789",
    epoAddressOverride: null,
  })).toEqual({ ok: true, value: null });
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  return company;
}

it.each([
  ["dphdp3", "03.01.04"],
  ["dphkh1", "03.01.15"],
] as const)("stores every %s draft XML as an immutable reproducible artifact", async (format, schemaVersion) => {
  const company = await preparedCompany();
  const user = await companyMember(company);

  const exported = await exportVatReport(user.client, {
    companyId: company.companyId,
    period: "2026-10",
    format,
    details,
  });

  expect(exported.ok).toBe(true);
  if (!exported.ok) throw new Error(exported.error);
  expect(exported.value.fileName).toBe(`DRAFT_${format.toUpperCase()}_2026-10.xml`);
  expect(exported.value.bytes).toEqual(new TextEncoder().encode(exported.value.xml));
  const history = await listVatReportArtifacts(user.client, {
    companyId: company.companyId,
    period: "2026-10",
  });
  expect(history).toHaveLength(1);
  expect(history[0]).toEqual(expect.objectContaining({
    id: exported.value.artifactId,
    companyId: company.companyId,
    format,
    kind: "draft",
    fileName: `DRAFT_${format.toUpperCase()}_2026-10.xml`,
    byteSize: exported.value.bytes.length,
    sha256: createHash("sha256").update(exported.value.bytes).digest("hex"),
    schemaVersion,
    serializerVersion: "2",
    authorUserId: expect.any(String),
    authorEmail: expect.stringContaining("@example.test"),
    createdAt: expect.any(String),
    resolvedDetails: expect.objectContaining({
      taxOffice: "451",
      territorialOffice: "2003",
      economicActivity: "621000",
      preparedOn: "2026-10-27",
      email: "podatelna@example.test",
      phone: "+420123456789",
    }),
  }));
  const stored = await readVatReportArtifact(user.client, {
    companyId: company.companyId,
    artifactId: exported.value.artifactId,
  });
  expect(stored).toEqual({ artifact: history[0], bytes: exported.value.bytes });
  expect((await listAuditEvents(company.client, company.organizationId)).at(-1)).toEqual(
    expect.objectContaining({
      action: "vat_report_artifact.created",
      companyId: company.companyId,
      targetId: exported.value.artifactId,
      payload: {
        vat_report_id: history[0].vatReportId,
        period_lock_id: null,
        period: "2026-10",
        format,
        kind: "draft",
        sha256: history[0].sha256,
        schema_version: schemaVersion,
        serializer_version: "2",
      },
    }),
  );

  const changed = await user.client.from("vat_report_artifact")
    .update({ file_name: "changed.xml" })
    .eq("id", exported.value.artifactId);
  expect(changed.error).not.toBeNull();
  const removed = await user.client.from("vat_report_artifact")
    .delete()
    .eq("id", exported.value.artifactId);
  expect(removed.error).not.toBeNull();
});

it("keeps multiple draft versions and refuses artifact access across Organizations", async () => {
  const company = await preparedCompany();
  const first = await exportVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-10",
    format: "dphdp3",
    details,
  });
  const second = await exportVatReport(company.client, {
    companyId: company.companyId,
    period: "2026-10",
    format: "dphdp3",
    details: { ...details, email: "one-export@example.test" },
  });
  if (!first.ok || !second.ok) throw new Error("draft export failed");

  const history = await listVatReportArtifacts(company.client, {
    companyId: company.companyId,
    period: "2026-10",
  });
  expect(history.map((artifact) => artifact.id)).toEqual([second.value.artifactId, first.value.artifactId]);
  expect(history.map((artifact) => artifact.resolvedDetails.email)).toEqual([
    "one-export@example.test",
    "podatelna@example.test",
  ]);

  const outsider = await provisionedUser();
  expect(await listVatReportArtifacts(outsider.client, {
    companyId: company.companyId,
    period: "2026-10",
  })).toEqual([]);
  expect(await readVatReportArtifact(outsider.client, {
    companyId: company.companyId,
    artifactId: first.value.artifactId,
  })).toBeNull();
});

it.each(["dphdp3", "dphkh1"] as const)("a software release changes new %s generator identity while preserving archived XML", async format => {
  const company = await preparedCompany();
  const session = await company.client.auth.getSession();
  if (!session.data.session) throw new Error("User session missing");
  const installation = mkdtempSync(path.join(os.tmpdir(), "ivat-installed-release-"));
  try {
    for (const name of ["src", "schemas", "tsconfig.json"]) cpSync(name, path.join(installation, name), { recursive: true });
    cpSync("tests/support/release-export-runner.ts", path.join(installation, "run.ts"));
    symlinkSync(path.resolve("node_modules"), path.join(installation, "node_modules"), "dir");
    function exportFromInstalledRelease(tag: string, revision: string, kind: "draft" | "final", archiveIds: string[] = []) {
      execFileSync(process.execPath, [path.resolve("scripts/write-release-identity.mjs"), tag, revision], { cwd: installation });
      return JSON.parse(execFileSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "run.ts"], {
        cwd: installation,
        input: JSON.stringify({ url: inject("supabaseUrl"), key: inject("supabaseAnonKey"), accessToken: session.data.session!.access_token, kind, input: { companyId: company.companyId, period: "2026-10", format, details }, archiveIds }),
        env: { ...process.env, IVAT_RELEASE_TAG: "v9.9.9", npm_package_version: "0.1.0" },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      })) as { download: Omit<EpoDownload, "bytes"> & { bytes: string }; archives: { artifact: VatReportArtifact; bytes: string }[] };
    }
    const draft = exportFromInstalledRelease("v0.2.0", "a".repeat(40), "draft").download;
    expect(draft.xml).toContain('verzeSW="v0.2.0+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(await finalizeVatReport(company.client, { companyId: company.companyId, period: "2026-10", confirmed: true }))
      .toEqual({ ok: true, value: null });
    const final = exportFromInstalledRelease("v0.2.0", "a".repeat(40), "final").download;
    const before = await listVatReportArtifacts(company.client, { companyId: company.companyId, period: "2026-10" });
    const upgraded = exportFromInstalledRelease("v0.3.0", "b".repeat(40), "final", [draft.artifactId, final.artifactId]);
    expect(upgraded.download.xml).toContain('verzeSW="v0.3.0+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"');
    expect(upgraded.download.reportGeneratedAt).toBe(final.reportGeneratedAt);
    expect(upgraded.download.periodLockId).toBe(final.periodLockId);
    expect(upgraded.archives.map(archive => archive.bytes)).toEqual([draft.bytes, final.bytes]);
    expect(upgraded.archives.map(archive => archive.artifact.sha256))
      .toEqual([draft, final].map(download => before.find(artifact => artifact.id === download.artifactId)!.sha256));
    for (const archive of upgraded.archives) {
      expect(Buffer.from(archive.bytes, "base64").toString("utf8")).toContain('verzeSW="v0.2.0+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    }
  } finally {
    rmSync(installation, { recursive: true, force: true });
  }
});
