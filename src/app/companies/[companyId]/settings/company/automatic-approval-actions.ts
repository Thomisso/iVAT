"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/actions";
import { setCompanyAutomaticApproval } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";

export async function setCompanyAutomaticApprovalAction(_state: FormState, formData: FormData): Promise<FormState> {
  const client = await requireUserClient();
  const companyId = String(formData.get("companyId") ?? "");
  const enabled = formData.get("automaticApprovalEnabled") === "on";
  const values = { automaticApprovalEnabled: enabled ? "on" : "" };
  const result = await setCompanyAutomaticApproval(client, { companyId, enabled });
  if (!result.ok) return { error: result.error, values };
  revalidatePath(`/companies/${companyId}/settings/company`);
  return { error: null, values: { ...values, saved: "yes" } };
}
