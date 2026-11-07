import type { AppClient } from "./client";

/** Reads the same trusted Prague civil date used by DB claim transitions. */
export async function currentBusinessDate(client: AppClient): Promise<string> {
  const { data, error } = await client.rpc("current_business_date");
  if (error) throw error;
  return data;
}
