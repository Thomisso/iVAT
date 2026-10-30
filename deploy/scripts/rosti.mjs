import { spawn } from "node:child_process";

process.loadEnvFile(".env.rosti");
const command = process.env.ROSTICLI_PATH ?? "rosticli";
const args = process.argv.slice(2);
if (args.length === 0) throw new Error("Pass the desired rosticli command and flags");
const child = spawn(command, args, { stdio: "inherit", env: process.env });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
