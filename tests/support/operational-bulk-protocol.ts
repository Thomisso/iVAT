export const operationalBulkCase = "splits 1001 new Documents in a Company with an active incident without restarting that incident's grace";
export const requestTestPhases = ["fixture", "configuration", "classified_issue", "initial_tick", "upload", "generation", "readback_assertions", "bulk_split", "reconciliation", "tick_299", "tick_300", "receipts", "finally_manual", "after_each", "cleanup"] as const;
export type RequestTestPhase = typeof requestTestPhases[number];
