"use server";

import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { logIn, logOut, signUp } from "@/application/auth";
import { createCompany, disableAiProcessing, enableAiProcessing } from "@/application/companies";
import { approveDocument, correctDocument, rejectDocument, reprocessDocument } from "@/application/documents";
import type { ExtractionPayload, Party } from "@/application/extraction-payload";
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

/** A field of the correction form: trimmed, and null when left empty. */
function optional(formData: FormData, name: string): string | null {
  return field(formData, name).trim() || null;
}

/** An amount as typed ("1 210,5") in the payload's form ("1210.50"); left as typed when it is no number. */
function amount(formData: FormData, name: string): string | null {
  const typed = optional(formData, name)?.replace(/\s/g, "").replace(",", ".");
  if (!typed || !/^-?\d+(\.\d{1,2})?$/.test(typed)) return typed ?? null;
  const [whole, decimals = ""] = typed.split(".");
  return `${whole}.${decimals.padEnd(2, "0")}`;
}

function party(formData: FormData, prefix: string): Party {
  const value = (name: string) => optional(formData, `${prefix}.${name}`);
  return {
    name: value("name"),
    ico: value("ico"),
    vatId: value("vatId")?.toUpperCase() ?? null,
    street: value("street"),
    city: value("city"),
    postalCode: value("postalCode"),
    country: value("country")?.toUpperCase() ?? null,
  };
}

/** The Extraction payload the correction form describes. Rate Breakdown lines left empty are dropped. */
function payloadFromForm(formData: FormData): ExtractionPayload {
  const lines = [...new Set([...formData.keys()].flatMap((key) => /^rateBreakdown\.(\d+)\./.exec(key)?.[1] ?? []))]
    .sort((a, b) => Number(a) - Number(b))
    .map((i) => ({
      rate: optional(formData, `rateBreakdown.${i}.rate`),
      netAmount: amount(formData, `rateBreakdown.${i}.netAmount`),
      vatAmount: amount(formData, `rateBreakdown.${i}.vatAmount`),
    }))
    .filter((line) => line.rate || line.netAmount || line.vatAmount);
  return {
    schemaVersion: 1,
    documentType: optional(formData, "documentType") as ExtractionPayload["documentType"],
    documentNumber: optional(formData, "documentNumber"),
    issueDate: optional(formData, "issueDate"),
    taxPointDate: optional(formData, "taxPointDate"),
    dueDate: optional(formData, "dueDate"),
    direction: optional(formData, "direction") as ExtractionPayload["direction"],
    supplier: party(formData, "supplier"),
    customer: party(formData, "customer"),
    currency: optional(formData, "currency")?.toUpperCase() ?? null,
    rateBreakdown: lines.map((line) => ({
      rate: line.rate === null ? NaN : Number(line.rate.replace(",", ".")),
      // A line with a rate but no amount reads as zero, which the arithmetic checks (#36) will question.
      netAmount: line.netAmount ?? "0.00",
      vatAmount: line.vatAmount ?? "0.00",
    })),
    totals: {
      netAmount: amount(formData, "totals.netAmount"),
      vatAmount: amount(formData, "totals.vatAmount"),
      grossAmount: amount(formData, "totals.grossAmount"),
    },
    payment: {
      variableSymbol: optional(formData, "payment.variableSymbol"),
      bankAccount: optional(formData, "payment.bankAccount"),
      iban: optional(formData, "payment.iban"),
    },
    proposedVatRegime: optional(formData, "proposedVatRegime") as ExtractionPayload["proposedVatRegime"],
    originalDocumentNumber: optional(formData, "originalDocumentNumber"),
  };
}

export async function correctDocumentAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await correctDocument(await requireUserClient(), {
    companyId: field(formData, "companyId"),
    documentId: field(formData, "documentId"),
    basedOnVersion: Number(field(formData, "basedOnVersion")),
    payload: payloadFromForm(formData),
  });
  if (!result.ok) {
    const values = [...formData.entries()].filter(([name, value]) => !name.startsWith("$") && typeof value === "string");
    return { error: result.error, values: Object.fromEntries(values) as Record<string, string> };
  }
  refresh();
  return { error: null, values: {} };
}

export async function approveDocumentAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(
    await approveDocument(await requireUserClient(), {
      companyId: field(formData, "companyId"),
      documentId: field(formData, "documentId"),
      version: Number(field(formData, "version")),
    }),
  );
}

export async function rejectDocumentAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(
    await rejectDocument(await requireUserClient(), {
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
