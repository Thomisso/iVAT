import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { emptyDocumentPayload } from "@/application/extraction-payload";
import type { AiProvider } from "@/application/ai-provider";
import { runEvaluationCli } from "@/evaluation/evaluation-cli";

async function privateFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ivat-private-evaluation-"));
  const expected = { ...emptyDocumentPayload(), documentNumber: "PRIVATE-INVOICE-989", totals: { netAmount: "76543.21", vatAmount: null, grossAmount: null } };
  await writeFile(path.join(directory, "private-source.png"), await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer());
  await writeFile(path.join(directory, "private-reference.json"), JSON.stringify(expected));
  const manifest = path.join(directory, "private-manifest.json");
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, cases: [{ id: "PRIVATE-BUSINESS-ID", source: "private-source.png", format: "png", pageCount: 1,
    company: { ico: "12345678", vatId: "CZ12345678" }, expectedSplit: [{ firstPage: 1, lastPage: 1 }],
    documents: [{ pages: { firstPage: 1, lastPage: 1 }, expected: "private-reference.json" }] }] }));
  const provider: AiProvider = { name: "PRIVATE-PROVIDER-LABEL", region: "local",
    async split() { return { model: "PRIVATE-MODEL-NAME", documents: [{ firstPage: 1, lastPage: 1 }] }; },
    async extract() { throw new Error("PRIVATE-FAILURE-DATA"); },
  };
  return { directory, manifest, provider };
}

describe("Extraction evaluation CLI", () => {
  it("writes partial raw evidence privately and prints only safe aggregates with exit 2", async () => {
    const fixture = await privateFixture();
    const reportPath = path.join(fixture.directory, "private-report.json");
    const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "partial", cases: 1, documents: 1, results: [{ coverage: { extraction: { completed: 0, failed: 1, missing: 0 } }, criticalDocuments: { correct: 0, total: 1, missing: 1 } }] });
    const raw = JSON.parse(await readFile(reportPath, "utf8"));
    expect(raw.dataset.cases[0]).toMatchObject({ id: "PRIVATE-BUSINESS-ID", documents: [{ expected: { documentNumber: "PRIVATE-INVOICE-989" } }] });
    expect(raw.results[0].calls[1].error.message).toBe("PRIVATE-FAILURE-DATA");
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    for (const privateValue of [fixture.directory, "PRIVATE-", "12345678", "76543.21", "private-source"]) {
      expect(result.stdout).not.toContain(privateValue);
      expect(result.stderr).not.toContain(privateValue);
    }
  });
  it("refuses a raw report inside Git, including a symlinked directory, before any AI calls", async () => {
    const fixture = await privateFixture();
    let called = false;
    fixture.provider.split = async () => { called = true; throw new Error("unexpected call"); };
    await symlink(process.cwd(), path.join(fixture.directory, "repo-link"));
    for (const reportPath of [path.join(process.cwd(), "private-report-must-not-exist.json"), path.join(fixture.directory, "repo-link", "private-report-must-not-exist.json")]) {
      const result = await runEvaluationCli({ argv: [fixture.manifest], env: { EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      await expect(stat(reportPath)).rejects.toThrow();
    }
    expect(called).toBe(false);
  });

  it("never overwrites an existing raw report", async () => {
    const fixture = await privateFixture();
    const reportPath = path.join(fixture.directory, "previous-report.json");
    await writeFile(reportPath, "previous private evidence");
    const result = await runEvaluationCli({ argv: [fixture.manifest], env: { EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(1);
    expect(await readFile(reportPath, "utf8")).toBe("previous private evidence");
  });

  it("returns complete and wholly failed process states without a percentage gate", async () => {
    const fixture = await privateFixture();
    fixture.provider.extract = async () => ({ model: "extract-v1", payload: { ...emptyDocumentPayload(), documentNumber: "wrong" } });
    const completed = await runEvaluationCli({ argv: [fixture.manifest], env: { EVALUATION_REPORT_PATH: path.join(fixture.directory, "complete.json") }, providers: [{ provider: fixture.provider }] });
    expect(completed.exitCode).toBe(0);
    expect(completed.stdout).toContain("Run status: complete");
    expect(completed.stdout).toContain("Critical financial Documents: 0/1");
    fixture.provider.split = async () => { throw new Error("private failed Split"); };
    fixture.provider.extract = async () => { throw new Error("private failed Extraction"); };
    const failed = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { EVALUATION_REPORT_PATH: path.join(fixture.directory, "failed.json") }, providers: [{ provider: fixture.provider }] });
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: "failed", results: [{ split: { total: 1, missing: 1 }, criticalDocuments: { total: 1, missing: 1 } }] });
  });

  it("also refuses raw output inside a bare Git repository", async () => {
    const fixture = await privateFixture();
    const bare = path.join(fixture.directory, "bare.git");
    await promisify(execFile)("git", ["init", "--bare", bare]);
    const result = await runEvaluationCli({ argv: [fixture.manifest], env: { EVALUATION_REPORT_PATH: path.join(bare, "private-report.json") }, providers: [{ provider: fixture.provider }] });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    await expect(stat(path.join(bare, "private-report.json"))).rejects.toThrow();
  });

  it("changes dataset identity when the exact external reference or manifest bytes change", async () => {
    const fixture = await privateFixture();
    const paths = ["first.json", "changed-reference.json", "changed-manifest.json"].map(file => path.join(fixture.directory, file));
    const run = async (reportPath: string) => {
      const result = await runEvaluationCli({ argv: [fixture.manifest, "--json"], env: { EVALUATION_REPORT_PATH: reportPath }, providers: [{ provider: fixture.provider }] });
      expect(result.exitCode).toBe(2);
      return JSON.parse(await readFile(reportPath, "utf8"));
    };
    const first = await run(paths[0]);
    const referencePath = path.join(fixture.directory, "private-reference.json");
    await writeFile(referencePath, JSON.stringify(JSON.parse(await readFile(referencePath, "utf8")), null, 2));
    const changedReference = await run(paths[1]);
    await writeFile(fixture.manifest, JSON.stringify(JSON.parse(await readFile(fixture.manifest, "utf8")), null, 2));
    const changedManifest = await run(paths[2]);
    expect(new Set([first, changedReference, changedManifest].map(report => report.provenance.datasetHash)).size).toBe(3);
    expect(changedReference.provenance.manifestHash).toBe(first.provenance.manifestHash);
    expect(changedReference.dataset.cases[0].documents[0].referenceFileHash).not.toBe(first.dataset.cases[0].documents[0].referenceFileHash);
    expect(changedManifest.provenance.manifestHash).not.toBe(first.provenance.manifestHash);
    expect(changedManifest.results[0].calls[0].provenance.sourceHash).toBe(first.results[0].calls[0].provenance.sourceHash);
  });

});
