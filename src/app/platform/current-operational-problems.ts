import { cache } from "react";
import { listPlatformOperationalProblems } from "@/application/operational-problems";
import { requireUserClient } from "@/lib/supabase/server";

/** One authoritative snapshot shared by the Platform layout and current page render. */
export const currentPlatformOperationalProblems = cache(async () => (
  listPlatformOperationalProblems(await requireUserClient())
));
