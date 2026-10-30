import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// Explicit operator command for the pilot; public self-registration is disabled.
// Run interactively, never in CI: a new User's password is printed once.
const [email, ...flags] = process.argv.slice(2);
if (!email?.includes("@") || flags.some(flag => flag !== "--superadmin")) {
  throw new Error("Usage: node deploy/scripts/provision-user.mjs email [--superadmin]");
}
if (!process.env.SUPABASE_SECRET_KEY) throw new Error("SUPABASE_SECRET_KEY is required");
const client = createClient("http://gateway:8000", process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const normalizedEmail = email.trim().toLowerCase();
let user;
for (let page = 1; !user; page++) {
  const { data, error } = await client.auth.admin.listUsers({ page, perPage: 100 });
  if (error) throw error;
  user = data.users.find(candidate => candidate.email?.toLowerCase() === normalizedEmail);
  if (data.users.length < 100) break;
}
if (!user) {
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await client.auth.admin.createUser({ email: normalizedEmail, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Auth did not return a User");
  user = data.user;
  console.log(`Initial password (store privately): ${password}`);
}
if (flags.includes("--superadmin")) {
  const { error } = await client.from("platform_user").upsert({ user_id: user.id, role: "super_admin" }, { onConflict: "user_id" });
  if (error) throw error;
}
console.log(`User ${user.id} is ready${flags.includes("--superadmin") ? "; enroll TOTP at first sign-in" : ""}.`);
