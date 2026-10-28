"use server";

import { refresh } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { generateVatReport } from "@/application/vat-reports";
import { logIn, logOut, signUp, startGoogleSignIn } from "@/application/auth";
import {
  beginTotpEnrollment,
  completeTotpEnrollment,
  disenrollMfa,
  mfaPolicy,
  mfaStatus,
  setOrganizationMfaRequired,
  verifyRecoveryCode,
  verifyTotp,
  type TotpEnrollment,
} from "@/application/mfa";
import { mfaRedirectPath } from "@/application/mfa-routing";
import { prefillCompanyFromAres } from "@/application/ares";
import { createCompany, disableAiProcessing, enableAiProcessing, updateCompany } from "@/application/companies";
import { acceptInvitation, changeMembershipRole, inviteMember, removeMembership } from "@/application/memberships";
import { supabaseInvitationMailer } from "@/application/supabase-invitation-mailer";
import {
  approveDocument,
  correctDocument,
  mergeDocuments,
  moveDocumentPage,
  rejectDocument,
  reprocessDocument,
  splitDocument,
  updateDocumentReporting,
} from "@/application/documents";
import type { ExtractionPayload, Party } from "@/application/extraction-payload";
import { retrySplit, uploadSourceFile } from "@/application/source-files";
import { configurePlatformAiProvider, setOrganizationPlatformAiAccess } from "@/application/platform-ai";
import { removeOrganizationAiProviderKey, saveOrganizationAiProviderKey } from "@/application/organization-ai";
import { availableCompanyAiProviders } from "@/ai";
import { configuredAresRegistry } from "@/ares";
import { configuredExchangeRates } from "@/cnb";
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

const COMPANY_FIELDS = [
  "name",
  "ico",
  "vatId",
  "street",
  "city",
  "postalCode",
  "personType",
  "filingFrequency",
  "filingFrequencyEffectiveFrom",
];

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
  const client = await createRequestClient();
  const result = await logIn(client, {
    email: field(formData, "email"),
    password: field(formData, "password"),
  });
  if (!result.ok) return refused(result.error, formData, ["email"]);
  const destination = mfaRedirectPath("/", await mfaPolicy(client));
  if (destination) redirect(destination);
  redirect("/");
}

export async function googleSignInAction(): Promise<void> {
  const origin = (await headers()).get("origin");
  if (!origin) redirect("/login?error=google_sign_in_failed");
  const result = await startGoogleSignIn(await createRequestClient(), {
    redirectTo: new URL("/auth/callback", origin).toString(),
  });
  if (!result.ok) redirect("/login?error=google_sign_in_failed");
  redirect(result.value.url);
}

export async function logOutAction(): Promise<void> {
  await logOut(await createRequestClient());
  redirect("/login");
}

export type MfaEnrollmentState = {
  error: string | null;
  enrollment: TotpEnrollment | null;
};

export type MfaCompletionState = {
  error: string | null;
  recoveryCodes: string[] | null;
};

export async function beginTotpEnrollmentAction(): Promise<MfaEnrollmentState> {
  const result = await beginTotpEnrollment(await requireUserClient());
  return result.ok ? { error: null, enrollment: result.value } : { error: result.error, enrollment: null };
}

export async function completeTotpEnrollmentAction(
  _state: MfaCompletionState,
  formData: FormData,
): Promise<MfaCompletionState> {
  const result = await completeTotpEnrollment(await requireUserClient(), {
    factorId: field(formData, "factorId"),
    code: field(formData, "code"),
  });
  return result.ok
    ? { error: null, recoveryCodes: result.value.recoveryCodes }
    : { error: result.error, recoveryCodes: null };
}

export async function verifyTotpAction(_state: FormState, formData: FormData): Promise<FormState> {
  const client = await requireUserClient();
  const status = await mfaStatus(client);
  if (!status.factorId) redirect("/mfa/enroll");
  const result = await verifyTotp(client, {
    factorId: status.factorId,
    code: field(formData, "code"),
  });
  if (!result.ok) return refused(result.error, formData, []);
  redirect("/");
}

export async function verifyRecoveryCodeAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await verifyRecoveryCode(await requireUserClient(), field(formData, "recoveryCode"));
  if (!result.ok) return refused(result.error, formData, []);
  redirect("/");
}

export async function disenrollMfaAction(): Promise<void> {
  const client = await requireUserClient();
  const status = await mfaStatus(client);
  if (status.factorId) await disenrollMfa(client, status.factorId);
  redirect("/settings/security");
}

export async function setOrganizationMfaRequiredAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(
    await setOrganizationMfaRequired(await requireUserClient(), {
      organizationId: field(formData, "organizationId"),
      required: field(formData, "required") === "true",
    }),
  );
}

export async function createCompanyAction(_state: FormState, formData: FormData): Promise<FormState> {
  if (field(formData, "intent") === "ares") {
    const prefill = await prefillCompanyFromAres(configuredAresRegistry(), field(formData, "ico"));
    if (!prefill.ok) return refused(prefill.error, formData, COMPANY_FIELDS);
    return {
      error: null,
      values: {
        ...Object.fromEntries(COMPANY_FIELDS.map((name) => [name, field(formData, name)])),
        ...prefill.value,
      },
    };
  }
  const companyId = field(formData, "companyId");
  const settings = {
    name: field(formData, "name"),
    ico: field(formData, "ico"),
    vatId: field(formData, "vatId"),
    street: field(formData, "street"),
    city: field(formData, "city"),
    postalCode: field(formData, "postalCode"),
    personType: field(formData, "personType") as "legal" | "natural",
    filingFrequency: field(formData, "filingFrequency") as "monthly" | "quarterly",
    filingFrequencyEffectiveFrom: field(formData, "filingFrequencyEffectiveFrom"),
  };
  const client = await requireUserClient();
  if (companyId) {
    const result = await updateCompany(client, { companyId, ...settings });
    if (!result.ok) return refused(result.error, formData, COMPANY_FIELDS);
    redirect(`/companies/${companyId}`);
  }
  const result = await createCompany(client, {
    organizationId: field(formData, "organizationId"),
    ...settings,
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
    preselectedDirection:
      (optionalField(formData, "direction") as ExtractionPayload["direction"]) ??
      undefined,
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
  const client = await requireUserClient();
  const providerName = field(formData, "provider");
  const provider = (await availableCompanyAiProviders(client)).find((candidate) => candidate.name === providerName);
  if (!provider) return refused("unknown_provider", formData, ["provider"]);
  return settled(
    await enableAiProcessing(client, jobQueue, {
      companyId: field(formData, "companyId"),
      provider,
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

export async function mergeDocumentsAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(
    await mergeDocuments(await requireUserClient(), jobQueue, {
      companyId: field(formData, "companyId"),
      leftDocumentId: field(formData, "leftDocumentId"),
      rightDocumentId: field(formData, "rightDocumentId"),
    }),
  );
}

export async function splitDocumentAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(
    await splitDocument(await requireUserClient(), jobQueue, {
      companyId: field(formData, "companyId"),
      documentId: field(formData, "documentId"),
      splitAfterPage: Number(field(formData, "splitAfterPage")),
    }),
  );
}

export async function moveDocumentPageAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(
    await moveDocumentPage(await requireUserClient(), jobQueue, {
      companyId: field(formData, "companyId"),
      sourceDocumentId: field(formData, "sourceDocumentId"),
      targetDocumentId: field(formData, "targetDocumentId"),
      page: Number(field(formData, "page")),
    }),
  );
}

/** A field of the correction form, or null when left empty. */
function optionalField(formData: FormData, name: string): string | null {
  return field(formData, name).trim() || null;
}

function partyFromForm(formData: FormData, prefix: string): Party {
  const value = (name: string) => optionalField(formData, `${prefix}.${name}`);
  return {
    name: value("name"),
    ico: value("ico"),
    vatId: value("vatId"),
    street: value("street"),
    city: value("city"),
    postalCode: value("postalCode"),
    country: value("country"),
  };
}

/** The Extraction payload the correction form describes, as typed; `correctDocument` normalizes it. */
function payloadFromForm(formData: FormData): ExtractionPayload {
  const lines = [
    ...new Set([...formData.keys()].flatMap((key) => /^rateBreakdown\.(\d+)\./.exec(key)?.[1] ?? [])),
  ].sort((a, b) => Number(a) - Number(b));
  return {
    schemaVersion: 1,
    documentType: optionalField(formData, "documentType") as ExtractionPayload["documentType"],
    documentNumber: optionalField(formData, "documentNumber"),
    issueDate: optionalField(formData, "issueDate"),
    taxPointDate: optionalField(formData, "taxPointDate"),
    dueDate: optionalField(formData, "dueDate"),
    direction: optionalField(formData, "direction") as ExtractionPayload["direction"],
    supplier: partyFromForm(formData, "supplier"),
    customer: partyFromForm(formData, "customer"),
    currency: optionalField(formData, "currency"),
    rateBreakdown: lines.map((i) => ({
      rate: Number(optionalField(formData, `rateBreakdown.${i}.rate`)?.replace(",", ".") ?? NaN),
      netAmount: field(formData, `rateBreakdown.${i}.netAmount`),
      vatAmount: field(formData, `rateBreakdown.${i}.vatAmount`),
    })),
    totals: {
      netAmount: optionalField(formData, "totals.netAmount"),
      vatAmount: optionalField(formData, "totals.vatAmount"),
      grossAmount: optionalField(formData, "totals.grossAmount"),
    },
    payment: {
      variableSymbol: optionalField(formData, "payment.variableSymbol"),
      bankAccount: optionalField(formData, "payment.bankAccount"),
      iban: optionalField(formData, "payment.iban"),
    },
    proposedVatRegime: optionalField(formData, "proposedVatRegime") as ExtractionPayload["proposedVatRegime"],
    reverseChargeCode: optionalField(formData, "reverseChargeCode"),
    originalDocumentNumber: optionalField(formData, "originalDocumentNumber"),
  };
}

export async function correctDocumentAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await correctDocument(
    await requireUserClient(),
    {
      companyId: field(formData, "companyId"),
      documentId: field(formData, "documentId"),
      basedOnVersion: Number(field(formData, "basedOnVersion")),
      payload: payloadFromForm(formData),
    },
    configuredExchangeRates(),
  );
  if (!result.ok) {
    const values = [...formData.entries()].filter(
      ([name, value]) => !name.startsWith("$") && typeof value === "string",
    );
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

export async function updateDocumentReportingAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await updateDocumentReporting(await requireUserClient(), {
    companyId: field(formData, "companyId"),
    documentId: field(formData, "documentId"),
    receiptDate: field(formData, "receiptDate"),
    claimedReportingPeriod: optionalField(formData, "claimedReportingPeriod"),
  });
  if (!result.ok) {
    return refused(result.error, formData, [
      "receiptDate",
      "claimedReportingPeriod",
    ]);
  }
  refresh();
  return { error: null, values: {} };
}

export async function setLocaleAction(formData: FormData): Promise<void> {
  const locale = formData.get("locale");
  if (isLocale(locale)) {
    (await cookies()).set(localeCookie, locale, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
  }
}

export async function generateVatReportAction(_state: FormState, formData: FormData): Promise<FormState> {
  const companyId = field(formData, "companyId");
  const period = field(formData, "period");
  const result = await generateVatReport(await requireUserClient(), {
    companyId,
    period,
  });
  if (!result.ok) return refused(result.error, formData, ["period"]);
  redirect(`/companies/${companyId}/vat-reports?period=${encodeURIComponent(period)}`);
}

export async function inviteMemberAction(_state: FormState, formData: FormData): Promise<FormState> {
  const client = await requireUserClient();
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  if (!host) return refused("invitation_failed", formData, ["email", "role"]);
  const result = await inviteMember(client, supabaseInvitationMailer(client), {
    organizationId: field(formData, "organizationId"),
    companyId: field(formData, "companyId") || null,
    email: field(formData, "email"),
    role: field(formData, "role") as "administrator" | "user",
    acceptUrl: `${protocol}://${host}/invitations/accept`,
  });
  if (!result.ok) return refused(result.error, formData, ["email", "role"]);
  refresh();
  return { error: null, values: {} };
}

export async function acceptInvitationAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await acceptInvitation(await requireUserClient(), field(formData, "token"));
  if (!result.ok) return refused(result.error, formData, []);
  redirect("/");
}

export async function changeMembershipRoleAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(
    await changeMembershipRole(await requireUserClient(), {
      membershipId: field(formData, "membershipId"),
      role: field(formData, "role") as "administrator" | "user",
    }),
  );
}

export async function removeMembershipAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(await removeMembership(await requireUserClient(), field(formData, "membershipId")));
}

export async function configurePlatformAiProviderAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await configurePlatformAiProvider(await requireUserClient(), {
    provider: field(formData, "provider"),
    available: field(formData, "available") === "on",
    splitModel: field(formData, "splitModel"),
    extractModel: field(formData, "extractModel"),
    apiKey: field(formData, "apiKey").trim() || undefined,
  });
  if (!result.ok) return refused(result.error, formData, ["provider", "available", "splitModel", "extractModel"]);
  refresh();
  return { error: null, values: {} };
}

export async function setOrganizationPlatformAiAccessAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  return settled(await setOrganizationPlatformAiAccess(await requireUserClient(), {
    organizationId: field(formData, "organizationId"),
    provider: field(formData, "provider"),
    enabled: field(formData, "enabled") === "true",
  }));
}

export async function saveOrganizationAiProviderKeyAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await saveOrganizationAiProviderKey(await requireUserClient(), {
    organizationId: field(formData, "organizationId"),
    provider: field(formData, "provider"),
    apiKey: field(formData, "apiKey"),
    dpaAcknowledged: field(formData, "dpaAcknowledged") === "on",
  });
  // API keys are intentionally excluded: Server Action return values are serialized to the client.
  if (!result.ok) return refused(result.error, formData, ["provider", "dpaAcknowledged"]);
  refresh();
  return { error: null, values: {} };
}

export async function removeOrganizationAiProviderKeyAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  return settled(await removeOrganizationAiProviderKey(await requireUserClient(), {
    organizationId: field(formData, "organizationId"),
    provider: field(formData, "provider"),
  }));
}
