import { spawn } from "node:child_process";

// Postman's npm entry point launches a native CLI and HTTP workers. On Linux,
// signaling only the entry point leaves those descendants and their pipes alive.
export function spawnSimulation(file, port) {
  const child = spawn("postman", ["simulation", "run", file, "--port", String(port), "--no-history", "--output", "ndjson"], {
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let finished = false;
  const closed = new Promise(resolve => child.once("close", () => { finished = true; resolve(true); }));
  child.on("error", () => {}); // Readiness observes the failed exit; cleanup still awaits close.
  const wait = async milliseconds => {
    let timer;
    try { return await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  const signal = name => {
    try {
      if (!child.pid) return;
      if (process.platform === "win32") child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  return {
    child,
    async stop() {
      if (finished) return;
      signal("SIGTERM");
      if (await wait(2000)) return;
      signal("SIGKILL");
      if (!await wait(2000)) throw new Error("Simulation process group did not close after bounded cleanup.");
    },
  };
}
