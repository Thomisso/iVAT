import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Deliberately an allowlist. An unfamiliar file is a full verification change.
export function classifyChanges({ event, draft = false, fullVerification = false, files }) {
  if (event !== "pull_request" || fullVerification || files.length === 0) return "full";
  if (files.length > 0 && files.every(file =>
    /^(README|AGENTS|CODING_STANDARDS|GLOSSARY)\.md$/.test(file)
    || /^docs\/.+\.md$/.test(file)
  )) return "docs";
  return draft ? "draft" : "full";
}

export function verificationPassed(profile, results) {
  const quick = Array.isArray(results.quick) ? results.quick : [results.quick];
  return ["docs", "draft", "full"].includes(profile)
    && quick.length > 0 && quick.every(result => result === "success")
    && (!Object.hasOwn(results, "common") || results.common === (profile === "docs" ? "skipped" : "success"))
    && results.full === (profile === "full" ? "success" : "skipped");
}

if (process.argv[2] === "gate") {
  let passed = false;
  try {
    const results = {
      quick: process.env.QUICK_RESULTS === undefined ? process.env.QUICK_RESULT : JSON.parse(process.env.QUICK_RESULTS),
      full: process.env.FULL_RESULT,
    };
    if (Object.hasOwn(process.env, "COMMON_RESULT")) results.common = process.env.COMMON_RESULT;
    passed = (process.env.QUICK_RESULTS === undefined || Array.isArray(results.quick))
      && verificationPassed(process.env.PROFILE, results);
  } catch {
    // Malformed or incomplete result publication is failed verification.
  }
  if (!passed) {
    console.error("Required verification did not succeed", process.env.PROFILE, process.env.QUICK_RESULTS ?? process.env.QUICK_RESULT, process.env.COMMON_RESULT, process.env.FULL_RESULT);
    process.exitCode = 1;
  }
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  let files = [];
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    try {
      // NUL separation keeps unusual filenames unambiguous. Use the complete
      // merge-base diff rather than GitHub's paginated/capped changed-file API.
      files = execFileSync("git", ["diff", "--name-only", "-z", `${event.pull_request.base.sha}...HEAD`], { encoding: "utf8" }).split("\0").filter(Boolean);
    } catch {
      // An unavailable base is uncertain impact and must receive full checks.
    }
  }
  const profile = classifyChanges({ event: process.env.GITHUB_EVENT_NAME, draft: files.length > 0 && event.pull_request?.draft, fullVerification: event.pull_request?.labels?.some(label => label.name === "ci:full"), files });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `profile=${profile}\n`);
  console.log(`Verification profile: ${profile}`);
}
