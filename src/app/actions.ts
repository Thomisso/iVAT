"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { logIn, logOut, signUp } from "@/application/auth";
import { createCompany } from "@/application/companies";
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

export async function setLocaleAction(formData: FormData): Promise<void> {
  const locale = formData.get("locale");
  if (isLocale(locale)) {
    (await cookies()).set(localeCookie, locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  }
}
