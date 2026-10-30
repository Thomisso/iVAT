import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assertPublishedRelease } from "./release-policy.mjs";
import { validateReleaseBundle } from "./release-bundle.mjs";

// Decode only the regular files/directories our ustar producer emits. Never
// extract links, devices, PAX overrides or paths interpreted by a shell/tar.
export async function inspectReleaseArchive(bytes, verified, event) {
  const release = assertPublishedRelease("release", event);
  if (release.tag !== verified.tag || release.releaseId !== verified.releaseId ||
      event.repository?.full_name?.toLowerCase() !== verified.repository) throw new Error("Release event does not match verified identity.");
  const directory = await mkdtemp(path.join(tmpdir(), "ivat-release-inspect-"));
  try {
    if (bytes.length > 20_000_000) throw new Error("Release archive is too large.");
    const tar = gunzipSync(bytes, { maxOutputLength: 20_000_000 });
    const seen = new Set();
    let offset = 0;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) {
        if (!tar.subarray(offset).every(byte => byte === 0)) throw new Error("Invalid release archive trailer.");
        break;
      }
      const field = (start, length) => header.subarray(start, start + length).toString("utf8").split("\0")[0];
      const octal = value => { if (!/^[0-7]+$/.test(value.trim())) throw new Error("Invalid release archive header."); return Number.parseInt(value.trim(), 8); };
      const sum = [...header].reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (sum !== octal(field(148, 8))) throw new Error("Invalid release archive checksum.");
      const prefix = field(345, 155);
      const raw = (prefix ? prefix + "/" : "") + field(0, 100);
      const name = raw.replace(/^\.\//, "").replace(/\/$/, "");
      const type = field(156, 1);
      const size = octal(field(124, 12));
      const allowedDirectory = name === "" || ["deploy", "deploy/scripts"].includes(name);
      const allowedFile = name === "manifest.json" || name === "docker-compose.rosti.yml" || name === "deploy/restore.yml" || /^deploy\/scripts\/[a-z0-9][a-z0-9._-]*\.(mjs|sh)$/.test(name);
      if (seen.has(name) || !((type === "5" && allowedDirectory && size === 0) || (["", "0"].includes(type) && allowedFile))) throw new Error("Unsafe or unexpected release archive entry.");
      seen.add(name);
      offset += 512;
      if (offset + size > tar.length) throw new Error("Truncated release archive.");
      if (type === "5") await mkdir(path.join(directory, name), { recursive: true });
      else {
        await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
        await writeFile(path.join(directory, name), tar.subarray(offset, offset + size), { flag: "wx", mode: 0o600 });
      }
      offset += Math.ceil(size / 512) * 512;
    }
    const manifest = await validateReleaseBundle(directory);
    for (const key of ["repository", "revision", "tag", "releaseId"]) if (manifest[key] !== verified[key]) throw new Error("Release bundle does not match verified identity.");
    return manifest;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export async function deployPreparedRelease({ archive, verified, event, ssh, project, actor, attemptId, stack = "/srv/stack", pollMs = 5000, timeoutMs = 50 * 60_000 }) {
  // This must complete before any SSH connection or production credential use.
  const manifest = await inspectReleaseArchive(archive, verified, event);
  if (!ssh || [ssh.host, ssh.user, project, actor, attemptId, stack, ssh.privateKey, ssh.knownHosts].some(value => typeof value !== "string" || !value.trim()) ||
      !/^[a-zA-Z0-9.-]+$/.test(ssh.host) || !Number.isSafeInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535 ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(ssh.user) ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(project) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(actor) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(attemptId) || !/^\/[a-zA-Z0-9/._-]+$/.test(stack) || stack.split("/").includes("..")) throw new Error("Invalid reviewed SSH/deployment configuration.");
  const registry = process.env.GHCR_TOKEN, provider = process.env.ROSTI_API_KEY;
  if (!registry || !provider || /[\r\n]/.test(registry + provider)) throw new Error("Separate single-line deployment credentials are required.");
  const temporary = await mkdtemp(path.join(tmpdir(), "ivat-release-ssh-"));
  const incoming = `${stack}/deploy/incoming/${attemptId}`;
  const bundle = `${incoming}/bundle`;
  const launcher = `${bundle}/deploy/scripts/launch-release.sh`;
  const remote = async (command, input = "") => {
    const args = ["-T", "-p", String(ssh.port), "-i", path.join(temporary, "key"),
      "-o", `UserKnownHostsFile=${path.join(temporary, "known_hosts")}`, "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
      "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "ConnectTimeout=15",
      "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3",
      `${ssh.user}@${ssh.host}`, `sh -c ${quote(command)}`];
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      let output = "", overflow = false;
      const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
      child.stdout.on("data", chunk => { if (output.length + chunk.length > 1_000_000) { overflow = true; child.kill("SIGTERM"); } else output += chunk; });
      // Host logs stay private, including any provider/Compose diagnostics.
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", () => { clearTimeout(timer); reject(new Error("SSH transport could not start.")); });
      child.on("close", code => {
        clearTimeout(timer);
        if (code !== 0 || overflow) reject(new Error("SSH transport failed; host outcome is unknown. Inspect the recorded transport and attempt before retrying."));
        else resolve(output);
      });
      child.stdin.end(input);
    });
  };
  const launchCommand = operation => ["bash", launcher, operation, stack, bundle, project, attemptId, actor].map(quote).join(" ");
  try {
    await writeFile(path.join(temporary, "key"), ssh.privateKey.endsWith("\n") ? ssh.privateKey : ssh.privateKey + "\n", { flag: "wx", mode: 0o600 });
    await writeFile(path.join(temporary, "known_hosts"), ssh.knownHosts + "\n", { flag: "wx", mode: 0o600 });
    const digest = createHash("sha256").update(archive).digest("hex");
    await remote(`set -eu; umask 077; mkdir -p ${quote(stack + "/deploy/incoming")}; mkdir ${quote(incoming)}; mkdir ${quote(bundle)}; cat > ${quote(incoming + "/release.tar.gz")}; printf '%s\\n' ${quote(digest + "  " + incoming + "/release.tar.gz")} | sha256sum -c - >/dev/null; tar -xzf ${quote(incoming + "/release.tar.gz")} -C ${quote(bundle)}; rm ${quote(incoming + "/release.tar.gz")}`, archive);
    if ((await remote(launchCommand("start"), `${registry}\n${provider}\n`)).trim() !== "launched") throw new Error("Host launch was not acknowledged; inspect transport before retrying.");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [result, phase, intervention] = (await remote(launchCommand("status"))).trim().split("\n");
      if (intervention === "needs-intervention") throw new Error(`Deployment ${attemptId} needs operator intervention; the host retains its lock until migration state is known.`);
      if (result === "failed") throw new Error(`Deployment ${attemptId} failed at ${/^[a-z-]+$/.test(phase) ? phase : "unknown phase"}. Inspect deploy/transports/${attemptId} and deploy/attempts/${attemptId}; recovery is operator-controlled.`);
      if (result === "success") {
        let record;
        try { record = JSON.parse(await remote(`cat ${quote(stack + "/deploy/verified-release.json")}`)); } catch { throw new Error("Unable to confirm the verified host record; inspect the attempt before retrying."); }
        if (record.attempt !== `deploy/attempts/${attemptId}` || ["repository", "revision", "tag", "releaseId"].some(key => record[key] !== manifest[key]) ||
            Object.keys(manifest.images).some(key => record.images?.[key] !== manifest.images[key])) throw new Error("Host record does not match the selected release; operator inspection is required.");
        return { ...manifest, attempt: record.attempt, deployedAt: record.deployedAt };
      }
      if (result !== "running") throw new Error("Host deployment outcome is unknown; inspect the transport before retrying.");
      await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`Timed out observing deployment ${attemptId}; host outcome is unknown. Inspect transport/attempt records; do not interrupt the lock owner or automatically rerun.`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function main() {
  const [archiveFile, verifiedFile] = process.argv.slice(2);
  const verified = JSON.parse(await readFile(verifiedFile, "utf8"));
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (process.env.GITHUB_EVENT_NAME !== "release" || process.env.GITHUB_SHA !== verified.revision ||
      process.env.GITHUB_REPOSITORY?.toLowerCase() !== verified.repository || !/^[0-9]+$/.test(process.env.GITHUB_RUN_ID) || !/^[0-9]+$/.test(process.env.GITHUB_RUN_ATTEMPT)) throw new Error("Workflow does not match the verified release identity.");
  const result = await deployPreparedRelease({
    archive: await readFile(archiveFile), verified, event,
    ssh: { host: process.env.ROSTI_SSH_HOST, port: Number(process.env.ROSTI_SSH_PORT), user: process.env.ROSTI_SSH_USER, privateKey: process.env.ROSTI_SSH_KEY, knownHosts: process.env.ROSTI_SSH_KNOWN_HOSTS },
    project: process.env.ROSTI_COMPOSE_PROJECT, actor: process.env.GITHUB_ACTOR,
    attemptId: `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  });
  const summary = `Verified deployment of ${result.tag} at \`${result.revision}\`.\n\nAttempt: \`${result.attempt}\`.\n\n` + Object.entries(result.images).map(([name, image]) => `- ${name}: \`${image}\``).join("\n") + "\n";
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
  console.log(`Verified ${result.tag} at ${result.revision}.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(async error => {
  console.error(error.message);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, "Deployment did not report verified success. Inspect the failed step and host transport/attempt records before joint recovery. Cancellation or transport failure does not establish the host outcome.\n", { flag: "a" });
  process.exitCode = 1;
});
