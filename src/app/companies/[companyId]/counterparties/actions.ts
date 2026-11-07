"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { archiveCounterparty, createCounterparty, deleteCounterparty, restoreCounterparty, updateCounterparty } from "@/application/counterparties";
import type { FormState } from "@/app/actions";
import { requireUserClient } from "@/lib/supabase/server";

export async function saveCounterpartyAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const read = (key: string) => typeof formData.get(key) === "string" ? String(formData.get(key)) : "";
  const values = { companyId: read("companyId"), id: read("id"), name: read("name"),
    ico: read("ico"), vatId: read("vatId"), street: read("street"), city: read("city"),
    postalCode: read("postalCode"), countryCode: read("countryCode"),
    supplier: read("supplier"), customer: read("customer") };
  const client = await requireUserClient();
  const input = { ...values, supplier: values.supplier === "true", customer: values.customer === "true" };
  const result = values.id ? await updateCounterparty(client, input) : await createCounterparty(client, input);
  if (!result.ok) return { error: result.error, values };
  const id = result.value ? result.value.id : values.id;
  const base = `/companies/${values.companyId}/counterparties`;
  revalidatePath(base);
  redirect(`${base}/${id}?saved=1`);
}


async function runCounterpartyLifecycleAction(formData: FormData, command: typeof deleteCounterparty, destination: "detail" | "directory"): Promise<FormState> {
  const values = { companyId: String(formData.get("companyId") ?? ""), id: String(formData.get("id") ?? "") };
  const client = await requireUserClient();
  const result = await command(client, values);
  if (!result.ok) return { error: result.error, values };
  const base = `/companies/${values.companyId}/counterparties`;
  revalidatePath(base);
  revalidatePath(`${base}/${values.id}`);
  redirect(destination === "detail" ? `${base}/${values.id}` : base);
}

export async function archiveCounterpartyAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runCounterpartyLifecycleAction(formData, archiveCounterparty, "detail");
}

export async function restoreCounterpartyAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runCounterpartyLifecycleAction(formData, restoreCounterparty, "detail");
}

export async function deleteCounterpartyAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runCounterpartyLifecycleAction(formData, deleteCounterparty, "directory");
}
