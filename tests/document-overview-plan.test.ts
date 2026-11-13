import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClient, type Session } from "@supabase/supabase-js";
import { asUserClient } from "@/application/client";
import { withDocumentOverviewPlan } from "./support/document-overview-plan";

const boundary = vi.hoisted(() => ({ root: "", calls: [] as string[], failPlan: false }));
vi.mock("../scripts/supabase-status.mjs", () => ({ localSupabaseContext: () => ({ isLinkedWorktree: true, generatedWorkdir: boundary.root }) }));
vi.mock("pg", () => ({ Client: class {
  on() { return this; }
  async connect() { boundary.calls.push("connect"); }
  async end() { boundary.calls.push("end"); }
  async query(sql: string) {
    boundary.calls.push(sql.startsWith("explain") ? sql.includes("analyze") ? "analyze" : "plain" : sql);
    if (sql.startsWith("explain")) {
      if (boundary.failPlan) throw { code: "57014", detail: "private_pg_body_canary" };
      return { rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Index Scan", Schema: "public", "Relation Name": "document", "Index Name": "document_pkey", "Actual Rows": 1000, "Actual Loops": 1, Filter: "private_filter_canary", Output: ["private_payload_canary"], Plans: [{ "Node Type": "Limit", "Plan Rows": 1 }] }, "Execution Time": 12.5 }] }] };
    }
    if (sql.includes("current_user")) return { rows: [{ role: "authenticated", rls: "on", timeout: "750ms", read_only: "on" }] };
    return { rows: [] };
  }
} }));

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ivat-overview-plan-")); roots.push(root); boundary.root = root;
  fs.mkdirSync(path.join(root, "supabase"));
  fs.writeFileSync(path.join(root, "supabase/config.toml"), 'project_id = "ivat-wt79"\n[api]\nport = 62221\n[db]\nport = 62222\n');
  boundary.calls = []; boundary.failPlan = false;
  vi.stubEnv("IVAT_DOCUMENT_OVERVIEW_PLAN", "1");
  const client = asUserClient(createClient("http://127.0.0.1:62221", "private_key_canary"));
  const claims = { role: "authenticated", sub: "11111111-1111-4111-8111-111111111111", session_id: "private_session_canary" };
  vi.spyOn(client.auth, "getSession").mockResolvedValue({ data: { session: { access_token: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`, user: { id: claims.sub } } as Session }, error: null });
  return { client, root, options: { root, databaseUrl: "postgresql://private_password_canary@127.0.0.1:62222/postgres", supabaseUrl: "http://127.0.0.1:62221" }, output: () => fs.readFileSync(path.join(root, "test-results/document-overview-plan.json"), "utf8") };
}

it("collects an authenticated rollback plan only after the successful public read and strips query/private plan fields", async () => {
  const f = fixture(); const result = [{ id: "private_document_canary" }];
  const actual = await withDocumentOverviewPlan(f.client, "22222222-2222-4222-8222-222222222222", async () => { boundary.calls.push("public_read"); return result; }, f.options);
  expect(actual).toBe(result);
  expect(boundary.calls[0]).toBe("public_read");
  expect(boundary.calls).toContain("set local role authenticated");
  expect(boundary.calls).toContain("begin read only");
  expect(boundary.calls.slice(-2)).toEqual(["rollback", "end"]);
  expect(boundary.calls.filter(call => ["plain", "analyze"].includes(call))).toEqual(["plain", "analyze"]);
  const output = f.output();
  expect(JSON.parse(output).plain.plan[0].Plan).toEqual({ "Node Type": "Index Scan", Schema: "public", "Relation Name": "document", "Index Name": "document_pkey", "Actual Rows": 1000, "Actual Loops": 1, Plans: [{ "Node Type": "Limit", "Plan Rows": 1 }] });
  expect(output).not.toMatch(/private_|22222222|11111111|Filter|Output/);
});

it("retains the identical first public error and skips ANALYZE even when the post-read plan also times out", async () => {
  const f = fixture(); boundary.failPlan = true;
  const original = { code: "57014", details: "private_first_error_canary" };
  let caught: unknown;
  try { await withDocumentOverviewPlan(f.client, "22222222-2222-4222-8222-222222222222", async () => { boundary.calls.push("public_read"); throw original; }, f.options); }
  catch (error) { caught = error; }
  expect(caught).toBe(original);
  expect(boundary.calls.filter(call => ["plain", "analyze"].includes(call))).toEqual(["plain"]);
  expect(boundary.calls.slice(-2)).toEqual(["rollback", "end"]);
  const output = f.output();
  expect(JSON.parse(output)).toMatchObject({ publicRead: "failed", plain: { sqlState: "57014" }, analyze: { reason: "public_read_failed" } });
  expect(output).not.toMatch(/private_|22222222|11111111/);
});

it("does not acquire a DB connection when the selected context is not the allocated owned79 stack", async () => {
  const f = fixture();
  await withDocumentOverviewPlan(f.client, "22222222-2222-4222-8222-222222222222", async () => null, { ...f.options, databaseUrl: "postgresql://private_password_canary@127.0.0.1:62322/postgres" });
  expect(boundary.calls).not.toContain("connect");
  expect(JSON.parse(f.output())).toMatchObject({ unavailable: true });
});
