import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assertPublishedRelease, REQUIRED_WORKFLOWS, requiredChecksState, resolveReleaseRevision } from "./release-policy.mjs";
import { createCandidate, dispatchCandidateVerification, waitForCandidateVerification, confirmCandidate, assertReleaseEvidenceInputs } from "./release-evidence.mjs";
import { createReleaseBundle, validateReleaseBundle } from "./release-bundle.mjs";

// Historical runtime fixtures observe main workflow summaries through this
// helper. It is not release approval; production verify uses complete candidate proof.
export async function waitForRequiredChecks({ repository, revision, token, apiUrl = "https://api.github.com", timeoutMs = 35 * 60_000, pollMs = 10_000 }) {
  if (!token) throw new Error("GH_TOKEN with Actions read permission is required.");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const evidence = {};
    for (const workflow of REQUIRED_WORKFLOWS) {
      const query = new URLSearchParams({ head_sha: revision, branch: "main", event: "push", per_page: "100" });
      const url = `${apiUrl}/repos/${repository}/actions/workflows/${workflow}/runs?${query}`;
      let response;
      try {
        response = await fetch(url, {
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2026-03-10" },
          signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
        });
      } catch {
        if (Date.now() >= deadline) break;
        throw new Error(`GitHub workflow evidence request failed for ${workflow}.`);
      }
      if (!response.ok) throw new Error(`GitHub workflow evidence request failed for ${workflow} (HTTP ${response.status}).`);
      let body;
      try { body = await response.json(); } catch { throw new Error(`Invalid GitHub workflow evidence for ${workflow}.`); }
      if (!Array.isArray(body.workflow_runs)) throw new Error(`Invalid GitHub workflow evidence for ${workflow}.`);
      evidence[workflow] = body.workflow_runs;
    }
    if (Date.now() >= deadline) break;
    if (requiredChecksState(evidence, revision) === "success") return;
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error("Timed out waiting for successful CI and deployment verification for the exact main commit. Fix checks, then re-run preparation.");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "verify") {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    const release = assertPublishedRelease(process.env.GITHUB_EVENT_NAME, event);
    const repository = process.env.GITHUB_REPOSITORY?.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(repository) ||
        event.repository?.full_name?.toLowerCase() !== repository) throw new Error("Release repository does not match workflow repository.");
    const revision = resolveReleaseRevision(release.tag, process.env.GITHUB_SHA);
    const candidate = createCandidate({ repository, revision, tag: release.tag,
      publicBuild: { supabaseUrl: process.env.ROSTI_PUBLIC_SUPABASE_URL, publishableKey: process.env.ROSTI_PUBLIC_SUPABASE_KEY } });
    // Persist before dispatch. A lost response is ambiguous: resume this request
    // instead of dispatching another expensive verification blindly.
    await writeFile(args[0] + ".request.json", JSON.stringify({ candidate, releaseId: release.releaseId }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const runId = await dispatchCandidateVerification({ candidate, token: process.env.GH_TOKEN, apiUrl: process.env.GITHUB_API_URL });
    console.log(`Requested candidate verification run ${runId}; request ${candidate.requestId}.`);
    const receipt = await waitForCandidateVerification({ candidate, runId, token: process.env.GH_TOKEN, apiUrl: process.env.GITHUB_API_URL });
    await writeFile(args[0], JSON.stringify({ repository, revision, ...release, verification: { candidate, receipt } }, null, 2) + "\n", { flag: "wx" });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `revision=${revision}\ntag=${release.tag}\n`);
    console.log(`Verified ${release.tag} at ${revision}; complete candidate run ${receipt.runId}, attempt ${receipt.runAttempt}.`);
  } else if (command === "resume") {
    const { candidate, releaseId } = JSON.parse(await readFile(args[0], "utf8"));
    if (candidate?.purpose !== "release" || !Number.isSafeInteger(releaseId) || releaseId <= 0) throw new Error("Invalid production release request.");
    resolveReleaseRevision(candidate.tag, candidate.revision);
    const receipt = await waitForCandidateVerification({ candidate, token: process.env.GH_TOKEN, apiUrl: process.env.GITHUB_API_URL });
    await writeFile(args[1], JSON.stringify({ repository: candidate.repository, revision: candidate.revision, tag: candidate.tag, releaseId, verification: { candidate, receipt } }, null, 2) + "\n", { flag: "wx" });
  } else if (command === "confirm") {
    const release = JSON.parse(await readFile(args[0], "utf8"));
    const publicBuild = { supabaseUrl: process.env.ROSTI_PUBLIC_SUPABASE_URL, publishableKey: process.env.ROSTI_PUBLIC_SUPABASE_KEY };
    const candidate = assertReleaseEvidenceInputs(release, publicBuild);
    await confirmCandidate({ candidate, receipt: release.verification.receipt, token: process.env.GH_TOKEN, apiUrl: process.env.GITHUB_API_URL });
  } else if (command === "bundle") {
    const [releaseFile, imagesFile, outputDirectory] = args;
    const release = JSON.parse(await readFile(releaseFile, "utf8"));
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (revision !== release.revision) throw new Error("Checkout does not match the verified release commit.");
    assertReleaseEvidenceInputs(release, { supabaseUrl: process.env.ROSTI_PUBLIC_SUPABASE_URL, publishableKey: process.env.ROSTI_PUBLIC_SUPABASE_KEY });
    const images = JSON.parse(await readFile(imagesFile, "utf8"));
    const compose = JSON.parse(execFileSync("docker", ["compose", "-f", "docker-compose.rosti.yml", "config", "--no-interpolate", "--no-path-resolution", "--format", "json"], { encoding: "utf8" }));
    await createReleaseBundle({
      sourceDirectory: process.cwd(), outputDirectory, release, images, compose,
      publicBuild: { supabaseUrl: process.env.ROSTI_PUBLIC_SUPABASE_URL, publishableKey: process.env.ROSTI_PUBLIC_SUPABASE_KEY },
    });
    console.log(`Prepared complete four-image release bundle for ${release.revision}.`);
  } else if (command === "validate") {
    const manifest = await validateReleaseBundle(args[0]);
    console.log(`Validated release ${manifest.tag} at ${manifest.revision}.`);
  } else throw new Error("Usage: prepare-release.mjs verify <output.json> | resume <request.json> <output.json> | confirm <verified.json> | bundle <verified.json> <images.json> <directory> | validate <directory>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
