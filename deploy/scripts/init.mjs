import { randomBytes, createHmac } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";

// Generate once. Replacing these values on an existing database breaks sessions
// and database access; this script refuses to overwrite its output.
const output = process.argv[2] ?? ".env.rosti";
const secret = randomBytes(48).toString("base64url");
const now = Math.floor(Date.now() / 1000);
function token(role) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role, iss: "supabase", iat: now, exp: now + 10 * 365 * 86400 })).toString("base64url");
  const body = `${header}.${payload}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
const values = {
  APP_HOST: "app.ivat.cz",
  API_HOST: "api.ivat.cz",
  APP_ORIGIN: "https://app.ivat.cz",
  SUPABASE_PUBLIC_URL: "https://api.ivat.cz",
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
  JWT_SECRET: secret,
  ANON_KEY: token("anon"),
  SERVICE_ROLE_KEY: token("service_role"),
  AI_PROVIDER: "platform",
  SMTP_HOST: "",
  SMTP_PORT: "587",
  SMTP_USER: "",
  SMTP_PASS: "",
  SMTP_ADMIN_EMAIL: "noreply@ivat.cz",
};
writeFileSync(output, Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n") + "\n", { flag: "wx", mode: 0o600 });
for (const directory of ["db", "db-keys", "storage"]) mkdirSync(`deploy/runtime/${directory}`, { recursive: true });
console.log(`Created ${output} with mode 0600. Configure SMTP; keep this file private and backed up.`);
