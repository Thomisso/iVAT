import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { Database } from "../src/lib/database.types";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

type Options =
  | { selector: "email"; value: string; passwordFromStdin: boolean }
  | { selector: "userId"; value: string; passwordFromStdin: false };

function optionsFromArgs(args: string[]): Options {
  let email: string | undefined;
  let userId: string | undefined;
  let passwordFromStdin = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--email") email = args[++index];
    else if (argument === "--user-id") userId = args[++index];
    else if (argument === "--password-stdin") passwordFromStdin = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if ((email ? 1 : 0) + (userId ? 1 : 0) !== 1) {
    throw new Error("Provide exactly one of --email or --user-id");
  }
  if (userId && passwordFromStdin) {
    throw new Error("--password-stdin can only be used with --email");
  }
  if (email) {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) throw new Error("--email requires a value");
    return { selector: "email", value: normalizedEmail, passwordFromStdin };
  }
  if (!userId?.trim()) throw new Error("--user-id requires a value");
  return { selector: "userId", value: userId, passwordFromStdin: false };
}

function localSupabaseUrl(): URL {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!value) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid URL");
  }
  if (!LOCAL_HOSTNAMES.has(url.hostname)) {
    throw new Error("SuperAdmin bootstrap only runs against a local Supabase endpoint");
  }
  return url;
}

function secretKey(): string {
  const value = process.env.SUPABASE_SECRET_KEY;
  if (!value) throw new Error("SUPABASE_SECRET_KEY is required");
  return value;
}

async function userByEmail(client: SupabaseClient<Database>, email: string): Promise<User | null> {
  const perPage = 1_000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Could not inspect Auth Users: ${error.message}`);
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) return user;
    if (page * perPage >= data.total) return null;
  }
}

function suppliedPassword(): string {
  const password = fs.readFileSync(0, "utf8").replace(/[\r\n]+$/, "");
  if (!password) throw new Error("--password-stdin requires a non-empty password on standard input");
  return password;
}

async function resolveUser(client: SupabaseClient<Database>, options: Options): Promise<User> {
  if (options.selector === "userId") {
    const { data, error } = await client.auth.admin.getUserById(options.value);
    if (error || !data.user) throw new Error(`Auth User ${options.value} does not exist`);
    return data.user;
  }

  const existing = await userByEmail(client, options.value);
  if (existing) return existing;

  const generatedPassword = options.passwordFromStdin ? null : randomBytes(24).toString("base64url");
  const password = generatedPassword ?? suppliedPassword();
  const { data, error } = await client.auth.admin.createUser({
    email: options.value,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Could not create Auth User: ${error?.message ?? "unknown error"}`);
  if (generatedPassword) console.log(`Generated one-time password: ${generatedPassword}`);
  return data.user;
}

async function main() {
  const url = localSupabaseUrl();
  const options = optionsFromArgs(process.argv.slice(2));
  const client = createClient<Database>(url.toString(), secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const user = await resolveUser(client, options);
  const { error: upsertError } = await client
    .from("platform_user")
    .upsert({ user_id: user.id, role: "super_admin" }, { onConflict: "user_id" });
  if (upsertError) throw new Error(`Could not grant SuperAdmin: ${upsertError.message}`);

  const { count, error: countError } = await client
    .from("platform_user")
    .select("user_id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("role", "super_admin");
  if (countError || count !== 1) throw new Error("Could not verify exactly one SuperAdmin record");
  console.log(`SuperAdmin ready for Auth User ${user.id}. Enroll TOTP after signing in.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "SuperAdmin bootstrap failed");
  process.exitCode = 1;
});
