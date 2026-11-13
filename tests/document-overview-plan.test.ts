import { expect, it } from "vitest";
import { cleanPlan } from "./support/document-overview-plan";

it("keeps useful plan metrics while stripping expressions, payloads and unsupported settings", () => {
  const result = cleanPlan([{ Plan: { "Node Type": "Index Scan", "Relation Name": "document", "Actual Rows": 1000, "Actual Loops": 1, Output: ["private_payload_canary"], Filter: "private_identifier_canary" }, Settings: { jit: "on", jit_above_cost: "100000", plan_cache_mode: "auto", jwt_secret: "private_secret_canary" } }]);
  expect(result).toEqual([{ Plan: { "Node Type": "Index Scan", "Relation Name": "document", "Actual Rows": 1000, "Actual Loops": 1 }, Settings: { jit: true, jit_above_cost: { value: 100000, unit: null }, plan_cache_mode: "auto" } }]);
  expect(JSON.stringify(result)).not.toContain("canary");
});
it("refuses invalid metric types, nonfinite values and arbitrary plan strings", () => {
  expect(cleanPlan({ "Actual Rows": "private_rows_canary", "Actual Loops": Infinity, "Execution Time": Number.NaN, "Relation Name": "private.path.canary", Settings: { work_mem: "private_setting_canary", jit: "not-a-boolean" } })).toEqual({ Settings: {} });
});
it("bounds plan fanout and recursive expansion before publication", () => {
  const deep: { Plan?: unknown } = {}; deep.Plan = deep;
  const result = cleanPlan(Array.from({ length: 200 }, () => deep)) as unknown[];
  expect(result).toHaveLength(128); expect(JSON.stringify(result).length).toBeLessThan(50000);
});
