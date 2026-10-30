import { execFileSync } from "node:child_process";

export const REQUIRED_WORKFLOWS = ["ci.yml", "deployment-check.yml"];

export function assertPublishedRelease(eventName, event) {
  const release = event?.release;
  if (eventName !== "release" || event?.action !== "published" ||
      !Number.isSafeInteger(release?.id) || release.id <= 0 ||
      release.draft !== false || release.prerelease !== false ||
      !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name)) {
    throw new Error("Expected a published stable Release with a vMAJOR.MINOR.PATCH tag.");
  }
  return { releaseId: release.id, tag: release.tag_name };
}
export function resolveReleaseRevision(tag, expectedRevision, directory = process.cwd()) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[a-f0-9]{40}$/.test(expectedRevision)) {
    throw new Error("Invalid release tag or commit.");
  }
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const revision = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
  if (revision !== expectedRevision) throw new Error("Release tag changed since publication; publish a new Release.");
  try {
    git("merge-base", "--is-ancestor", revision, "origin/main");
  } catch {
    throw new Error("Release commit is not on main.");
  }
  return revision;
}

export function requiredChecksState(evidence, revision) {
  let waiting = false;
  for (const workflow of REQUIRED_WORKFLOWS) {
    const runs = evidence[workflow];
    if (!Array.isArray(runs)) throw new Error(`Invalid workflow evidence for ${workflow}.`);
    const latest = runs.filter(run => run.head_sha === revision && run.head_branch === "main" && run.event === "push")
      .sort((a, b) => b.id - a.id)[0];
    if (!latest || latest.status !== "completed") waiting = true;
    else if (latest.conclusion !== "success") throw new Error(`${workflow} did not succeed for the release commit (${latest.conclusion}).`);
  }
  return waiting ? "waiting" : "success";
}
