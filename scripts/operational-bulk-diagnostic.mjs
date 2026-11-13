// Temporary diagnostic-only selection. Remove before normal APP integration.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export function diagnosticSelection(event, environment) {
  const branch = "fix/operational-post-cleanup-catalog-344";
  const diagnostic = environment.GITHUB_EVENT_NAME === "pull_request"
    && environment.IVAT_OPERATIONAL_DIAGNOSTIC_MODE === "post_cleanup_catalog_344"
    && environment.GITHUB_HEAD_REF === branch && event?.pull_request?.head?.ref === branch
    && event.repository?.full_name === "Thomisso/iVAT" && event.pull_request.head.repo?.full_name === "Thomisso/iVAT"
    && Array.isArray(event.pull_request.labels) && event.pull_request.labels.some(label => label?.name === "ci:full");
  return { diagnostic, reuse: diagnostic ? "" : environment.PR_REUSE ?? "" };
}

export function assertDiagnosticInventory(files, cases) {
  const isFile = row => typeof row?.file === "string" && row.file.replaceAll("\\", "/").endsWith("/tests/operational-email-alerts.test.ts");
  if (!Array.isArray(files) || files.length !== 1 || !isFile(files[0])
    || !Array.isArray(cases) || cases.length !== 89 || !cases.every(isFile)
    || cases[83]?.name !== "splits 1001 new Documents in a Company with an active incident without restarting that incident's grace") {
    throw new Error("Diagnostic selection is not the declared one file / 89 cases / target ordinal 84");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "inventory") {
    assertDiagnosticInventory(JSON.parse(fs.readFileSync(process.argv[3], "utf8")), JSON.parse(fs.readFileSync(process.argv[4], "utf8")));
    console.log("Diagnostic inventory: 1 file, 89 cases, target ordinal 84; no database executed");
    process.exit(0);
  }
  let event;
  try { event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")); } catch { /* Unknown context keeps normal full selection. */ }
  const selected = diagnosticSelection(event, process.env);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `diagnostic=${selected.diagnostic}\nreuse=${selected.reuse}\n`);
}
