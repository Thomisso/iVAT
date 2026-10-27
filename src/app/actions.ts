"use server";

import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { logIn, logOut, signUp } from "@/application/auth";
import { createCompany, disableAiProcessing, enableAiProcessing } from "@/application/companies";
import { reprocessDocument } from "@/application/documents";
import { retrySplit, uploadSourceFile } from "@/application/source-files";
import { configuredAiProvider } from "@/ai";
import { jobQueue } from "@/lib/jobs";
import { createRequestClient, requireUserClient } from "@/lib/supabase/server";
import { isLocale, localeCookie } from "@/i18n/locales";

/**
 * Form state: an error code that the form translates through the `errors`
 * messages, plus the submitted values so a refused form keeps its input
 * (React resets forms after an action). Passwords are never echoed back.
 */
export type FormState = { error: string | null; values: Record<string, string> };

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "");

function refused(error: string, formData: FormData, fields: string[]): FormState {
  return { error, values: Object.fromEntries(fields.map((name) => [name, field(formData, name)])) };
}

const COMPANY_FIELDS = ["name", "ico", "vatId", "street", "city", "postalCode"];

export async function signUpAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await signUp(await createRequestClient(), {
    email: field(formData, "email"),
    password: field(formData, "password"),
    organizationName: field(formData, "organizationName"),
  });
  if (!result.ok) return refused(result.error, formData, ["email", "organizationName"]);
  redirect("/companies/new");
}

export async function logInAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await logIn(await createRequestClient(), {
    email: field(formData, "email"),
    password: field(formData, "password"),
  });
  if (!result.ok) return refused(result.error, formData, ["email"]);
  redirect("/");
}

export async function logOutAction(): Promise<void> {
  await logOut(await createRequestClient());
  redirect("/login");
}

export async function createCompanyAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await createCompany(await requireUserClient(), {
    organizationId: field(formData, "organizationId"),
    name: field(formData, "name"),
    ico: field(formData, "ico"),
    vatId: field(formData, "vatId"),
    street: field(formData, "street"),
    city: field(formData, "city"),
    postalCode: field(formData, "postalCode"),
  });
  if (!result.ok) return refused(result.error, formData, COMPANY_FIELDS);
  redirect(`/companies/${result.value.id}`);
}

export async function uploadSourceFileAction(_state: FormState, formData: FormData): Promise<FormState> {
  const companyId = field(formData, "companyId");
  const file = formData.get("file");
  const result = await uploadSourceFile(await requireUserClient(), jobQueue, {
    companyId,
    fileName: file instanceof File ? file.name : "",
    bytes: file instanceof File ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(),
  });
  if (!result.ok) return refused(result.error, formData, []);
  redirect(`/companies/${companyId}/source-files/${result.value.id}`);
}

/** Maps a command's result for a form that stays on the page, refreshing it on success. */
function settled(result: { ok: true } | { ok: false; error: string }): FormState {
  if (!result.ok) return { error: result.error, values: {} };
  refresh();
  return { error: null, values: {} };
}

export async function enableAiProcessingAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(
    await enableAiProcessing(await requireUserClient(), jobQueue, {
      companyId: field(formData, "companyId"),
      provider: configuredAiProvider(),
    }),
  );
}

export async function disableAiProcessingAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(await disableAiProcessing(await requireUserClient(), field(formData, "companyId")));
}

export async function retrySplitAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(
    await retrySplit(await requireUserClient(), jobQueue, {
      companyId: field(formData, "companyId"),
      sourceFileId: field(formData, "sourceFileId"),
    }),
  );
}

export async function reprocessDocumentAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(
    await reprocessDocument(await requireUserClient(), jobQueue, {
      companyId: field(formData, "companyId"),
      documentId: field(formData, "documentId"),
    }),
  );
}

export async function setLocaleAction(formData: FormData): Promise<void> {
  const locale = formData.get("locale");
  if (isLocale(locale)) {
    (await cookies()).set(localeCookie, locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  }
}
