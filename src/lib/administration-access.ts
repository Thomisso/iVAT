import { cache } from "react";
import { listMyOrganizations } from "@/application/organizations";
import { isSuperAdmin } from "@/application/platform-ai";
import { requireUserClient } from "@/lib/supabase/server";

/** The current User's Organizations and SuperAdmin flag, loaded once per request for the administration navigation. */
export const loadAdministrationAccess = cache(async () => {
  const client = await requireUserClient();
  const [organizations, superAdmin] = await Promise.all([listMyOrganizations(client), isSuperAdmin(client)]);
  return { organizations, superAdmin };
});
