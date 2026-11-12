"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/app/actions";
import { createOrganization } from "@/application/organizations";
import { requireUserClient } from "@/lib/supabase/server";

export async function createOrganizationAction(_state: FormState, formData: FormData): Promise<FormState> {
  const values = { name: String(formData.get("name") ?? "") };
  const client = await requireUserClient();
  try {
    const result = await createOrganization(client, values);
    if (!result.ok) return { error: result.error, values };
  } catch {
    return { error: "organization_creation_failed", values };
  }
  revalidatePath("/platform/administration");
  redirect("/platform/administration");
}
