import type { AppClient } from "./client";

/** UI hint only; database functions remain the authority for every platform action. */
export async function isSuperAdmin(client: AppClient): Promise<boolean> {
  const { data, error } = await client.rpc("current_user_can_administrate_platform");
  if (error) return false;
  return data;
}
