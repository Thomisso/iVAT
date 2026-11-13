import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { Client } from "pg";
import { beginUploadBatch, listUploadBatches } from "@/application/upload-batches";
import { administratorWithCompany } from "./support/fixtures";
import { selectFixtureFiles } from "./support/files";
import { withPostgrestRowLimit } from "./support/postgrest";

let owner: Awaited<ReturnType<typeof administratorWithCompany>>;
let originalSetting: string | undefined;
let capObserved = false;
let timeoutErrors: string[] = [];
let finishAbandonedOperation: () => void;
let abandonedOperation: Promise<void>;

const probe = () => owner.client.from("upload_batch").select("id").eq("company_id", owner.companyId).limit(10);
const batches = () => listUploadBatches(owner.client, owner.companyId);

beforeAll(async () => {
  owner = await administratorWithCompany();
  for (let index = 0; index < 4; index++) {
    const result = await beginUploadBatch(owner.client, {
      companyId: owner.companyId, fileCount: 1,
      selectedFiles: selectFixtureFiles("receipt.png").selectedFiles,
    });
    if (!result.ok) throw new Error(result.error);
  }
  expect(await batches()).toHaveLength(4);
  const database = new Client({ connectionString: inject("databaseUrl") });
  await database.connect();
  try {
    const previous = await database.query<{ setting: string }>(
      "select unnest(rolconfig) as setting from pg_roles where rolname = 'authenticator'",
    );
    originalSetting = previous.rows.find(row => row.setting.startsWith("pgrst.db_max_rows="))?.setting.split("=")[1];
  } finally { await database.end(); }
});

// This independent outer teardown also protects the rest of the suite when the
// regression goes red. Assertions below still observe the public User query.
afterAll(async () => {
  try {
    if (finishAbandonedOperation) {
      finishAbandonedOperation();
      await abandonedOperation;
    }
  } finally {
    const database = new Client({ connectionString: inject("databaseUrl") });
    await database.connect();
    try {
      if (originalSetting === undefined) await database.query("alter role authenticator reset pgrst.db_max_rows");
      else {
        if (!/^\d+$/.test(originalSetting)) throw new Error("Unexpected original response cap");
        await database.query(`alter role authenticator set pgrst.db_max_rows = '${originalSetting}'`);
      }
      await database.query("notify pgrst, 'reload config'");
      const deadline = Date.now() + 5_000;
      while ((await batches()).length !== 4) {
        if (Date.now() >= deadline) throw new Error("Independent response-cap cleanup failed");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } finally { await database.end(); }
  }
});

it.fails("lets the runner time out an abandoned operation while the real response cap is three", { timeout: 1_500 }, async context => {
  // Record the native result after the fixture's later-registered cleanup hook.
  // The next test rejects generic setup/assertion/cleanup errors as substitutes.
  context.onTestFinished(() => {
    timeoutErrors = context.task.result?.errors?.map(error => error.message) ?? [];
  });
  abandonedOperation = withPostgrestRowLimit(3, probe, async () => {
    expect(await batches()).toHaveLength(3);
    capObserved = true;
    await new Promise<void>(resolve => { finishAbandonedOperation = resolve; });
  });
  await abandonedOperation;
});

it("restores all rows after the native timeout and keeps a late finally from overwriting a newer cap", async () => {
  expect(capObserved).toBe(true);
  expect(timeoutErrors).toHaveLength(1);
  expect(timeoutErrors[0]).toMatch(/^Test timed out in 1500ms\./);
  expect(await batches()).toHaveLength(4);
  await withPostgrestRowLimit(2, probe, async () => {
    finishAbandonedOperation();
    await abandonedOperation;
    expect(await batches()).toHaveLength(2);
  });
  expect(await batches()).toHaveLength(4);
});

it("restores all rows after successful and rejected operations", async () => {
  await withPostgrestRowLimit(3, probe, async () => { expect(await batches()).toHaveLength(3); });
  expect(await batches()).toHaveLength(4);
  await expect(withPostgrestRowLimit(3, probe, async () => {
    expect(await batches()).toHaveLength(3);
    throw new Error("deliberate fixture failure");
  })).rejects.toThrow("deliberate fixture failure");
  expect(await batches()).toHaveLength(4);
});
