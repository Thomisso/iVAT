import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertReleaseEvidenceInputs, confirmCandidate } from "./release-evidence.mjs";
import { assertPublicBuild } from "./release-bundle.mjs";

const builds = {
  app: { context: ".", dockerfile: "Dockerfile" },
  db: { context: "deploy/db", dockerfile: "deploy/db/Dockerfile" },
  gateway: { context: "deploy/gateway", dockerfile: "deploy/gateway/Dockerfile" },
  proxy: { context: "deploy/proxy", dockerfile: "deploy/proxy/Dockerfile" },
};

async function main() {
  const [releaseFile, outputFile] = process.argv.slice(2);
  const release = JSON.parse(await readFile(releaseFile, "utf8"));
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (revision !== release.revision || !/^[a-f0-9]{40}$/.test(revision) ||
      release.repository !== process.env.GITHUB_REPOSITORY?.toLowerCase()) throw new Error("Checkout does not match the verified release.");
  const publicBuild = { supabaseUrl: process.env.ROSTI_PUBLIC_SUPABASE_URL, publishableKey: process.env.ROSTI_PUBLIC_SUPABASE_KEY };
  assertPublicBuild(publicBuild);
  const candidate = assertReleaseEvidenceInputs(release, publicBuild);
  await confirmCandidate({ candidate, receipt: release.verification.receipt, token: process.env.GH_TOKEN, apiUrl: process.env.GITHUB_API_URL });
  const run = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!/^[1-9]\d*$/.test(run) || !/^[1-9]\d*$/.test(attempt)) throw new Error("GitHub run identity is required for retained image tags.");
  const temporary = await mkdtemp(path.join(tmpdir(), "ivat-release-images-"));
  try {
    const images = {};
    for (const [name, build] of Object.entries(builds)) {
      const image = `ghcr.io/${release.repository}/${name}`;
      const metadata = path.join(temporary, `${name}.json`);
      const args = ["buildx", "build", "--platform", "linux/amd64", "--file", build.dockerfile,
        "--tag", `${image}:sha-${revision}-${run}-${attempt}`, "--metadata-file", metadata,
        "--label", `org.opencontainers.image.source=https://github.com/${release.repository}`,
        "--label", `org.opencontainers.image.version=${release.tag}`,
        "--label", `org.opencontainers.image.revision=${revision}`, "--push"];
      if (name === "app") args.push("--build-arg", `NEXT_PUBLIC_SUPABASE_URL=${publicBuild.supabaseUrl}`,
        "--build-arg", `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${publicBuild.publishableKey}`,
        "--build-arg", `IVAT_RELEASE_TAG=${release.tag}`, "--build-arg", `IVAT_RELEASE_REVISION=${revision}`);
      execFileSync("docker", [...args, build.context], { stdio: "inherit" });
      const digest = JSON.parse(await readFile(metadata, "utf8"))["containerimage.digest"];
      if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Build did not return an immutable digest: ${name}.`);
      images[name] = `${image}@${digest}`;
    }
    await writeFile(outputFile, JSON.stringify(images, null, 2) + "\n", { flag: "wx" });
    console.log("Published all four revision-addressed images; existing release tags were not replaced.");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
