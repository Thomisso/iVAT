import { expect, it } from "vitest";
import {
  COMPANY_EXPORT_POLL_INTERVAL_MS,
  forgetPendingCompanyExport,
  pollCompanyExportStatus,
  readPendingCompanyExport,
  rememberPendingCompanyExport,
} from "@/lib/company-export-polling";

const immediatePause = async () => {};

it("keeps polling beyond the former timeout until the export completes", async () => {
  let polls = 0;
  const status = await pollCompanyExportStatus(async () => (
    ++polls <= 1_000 ? "pending" : "completed"
  ), {
    signal: new AbortController().signal,
    pause: immediatePause,
  });

  expect(status).toBe("completed");
  expect(polls).toBe(1_001);
  expect((polls - 1) * COMPANY_EXPORT_POLL_INTERVAL_MS).toBeGreaterThan(380_000);
});

it.each(["failed", "stale"] as const)("stops on terminal %s status", async (terminal) => {
  let polls = 0;
  const status = await pollCompanyExportStatus(async () => {
    polls++;
    return polls === 1 ? "pending" : terminal;
  }, {
    signal: new AbortController().signal,
    pause: immediatePause,
  });

  expect(status).toBe(terminal);
  expect(polls).toBe(2);
});

it("aborts safely while the component is leaving", async () => {
  const controller = new AbortController();
  await expect(pollCompanyExportStatus(async () => "pending", {
    signal: controller.signal,
    pause: async () => controller.abort(),
  })).rejects.toMatchObject({ name: "AbortError" });
});

it("persists the pending export id so a reload can resume it", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const companyId = "00000000-0000-4000-8000-000000000001";
  const exportId = "00000000-0000-4000-8000-000000000002";

  rememberPendingCompanyExport(storage, companyId, exportId);
  expect(readPendingCompanyExport(storage, companyId)).toBe(exportId);
  forgetPendingCompanyExport(storage, companyId);
  expect(readPendingCompanyExport(storage, companyId)).toBeNull();
});
