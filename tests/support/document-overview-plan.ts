// Source-equivalent to the first listCompanyDocuments page at frozen2004.
// PostgREST's generated aggregation/wrapper is not captured by this plan.
export const documentOverviewPageSql = `select id, source_file_id, first_page, last_page, status, created_at,
 version, document_number, direction, tax_point_date, import_date, claimed_reporting_period,
 reporting_period, counterparty_name, counterparty_vat_id, counterparty_ico, currency,
 gross_amount, finding_count, proposed_vat_regime, extraction_version_id, reporting_payload,
 reporting_findings from public.document_overview where company_id=$1
 order by created_at desc, first_page asc, id asc limit 1000 offset 0`;
type Safe = null | string | number | boolean | Safe[] | { [key: string]: Safe };
const numericFields = new Set(["Startup Cost", "Total Cost", "Plan Rows", "Plan Width", "Actual Startup Time", "Actual Total Time", "Actual Rows", "Actual Loops", "Rows Removed by Filter", "Rows Removed by Join Filter", "Shared Hit Blocks", "Shared Read Blocks", "Shared Dirtied Blocks", "Shared Written Blocks", "Local Hit Blocks", "Local Read Blocks", "Temp Read Blocks", "Temp Written Blocks", "I/O Read Time", "I/O Write Time", "Sort Space Used", "Planning Time", "Execution Time", "Workers Planned", "Workers Launched", "Functions", "Generation", "Inlining", "Optimization", "Emission", "Total"]);
const nameFields = new Set(["Schema", "Relation Name", "Index Name", "Function Name"]);
const categoryFields = new Set(["Node Type", "Join Type", "Scan Direction", "Sort Method", "Sort Space Type", "Strategy", "Partial Mode", "Parent Relationship"]);
export const planSettingNames = new Set(["jit", "jit_above_cost", "jit_inline_above_cost", "jit_optimize_above_cost", "plan_cache_mode", "work_mem", "effective_cache_size", "random_page_cost", "seq_page_cost", "cpu_tuple_cost", "cpu_index_tuple_cost", "cpu_operator_cost", "max_parallel_workers_per_gather"]);
export function cleanPlanSetting(name: unknown, value: unknown): Safe | undefined {
  if (typeof name !== "string" || !planSettingNames.has(name) || typeof value !== "string") return undefined;
  if (["on", "off"].includes(value)) return value === "on";
  if (name === "plan_cache_mode" && ["auto", "force_custom_plan", "force_generic_plan"].includes(value)) return value;
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|kB|MB|GB)?$/);
  return match ? { value: Number(match[1]), unit: match[2] ?? null } : undefined;
}
export function cleanPlan(value: unknown, depth = 0): Safe {
  if (depth > 32) return null;
  if (Array.isArray(value)) return value.slice(0, 128).map(item => cleanPlan(item, depth + 1));
  if (!value || typeof value !== "object") return null;
  const safe: { [key: string]: Safe } = {};
  for (const [key, item] of Object.entries(value)) {
    if (numericFields.has(key) && typeof item === "number" && Number.isFinite(item) && item >= 0) safe[key] = item;
    else if (nameFields.has(key) && typeof item === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(item)) safe[key] = item;
    else if (categoryFields.has(key) && typeof item === "string" && /^[A-Za-z][A-Za-z -]{0,63}$/.test(item)) safe[key] = item;
    else if (["Plan", "Plans", "JIT", "Timing"].includes(key)) safe[key] = cleanPlan(item, depth + 1);
    else if (key === "Settings" && item && typeof item === "object") safe[key] = Object.fromEntries(Object.entries(item).flatMap(([name, value]): [string, Safe][] => {
      const valueSafe = cleanPlanSetting(name, value);
      return valueSafe === undefined ? [] : [[name, valueSafe]];
    }));
  }
  return safe;
}
