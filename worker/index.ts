import { PgBoss } from "pg-boss";

// Background job runner (ADR-0002). Job handlers are registered here as they
// are added; they live in the application layer so tests can run them directly.

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Missing environment variable DATABASE_URL. See .env.example.");

const boss = new PgBoss(connectionString);
boss.on("error", (error) => console.error("[worker]", error));

async function main() {
  await boss.start();
  console.log("[worker] started; waiting for jobs");
}

async function shutdown() {
  console.log("[worker] stopping");
  await boss.stop({ graceful: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error("[worker] failed to start", error);
  process.exit(1);
});
