"use server";

import { refresh } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  finalizeVatReport,
  generateVatReport,
  unlockReportingPeriod,
} from "@/application/vat-reports";
import { currentUser, logIn, logOut, signUp, startGoogleSignIn } from "@/application/auth";
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
import {
  createCompanyIdentity,
  getCompany,
  setCurrentReportingYear,
  updateCompanyIdentity,
} from "@/application/companies";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import {
  changeReportingYearFrequency,
  deleteReportingYear,
  generateReportingYears,
  setFirstReportingMonth,
} from "@/application/reporting-years";
import { changeMembershipRole, completeInvitationOnboarding, inviteMember, removeMembership } from "@/application/memberships";
import { supabaseInvitationMailer } from "@/application/supabase-invitation-mailer";
import { invitationUrls } from "@/application/invitation-urls";
import {
  approveDocument,
  correctDocument,
  mergeDocuments,
  moveDocumentPage,
  rejectDocument,
  returnDocumentToReview,
  reprocessDocument,
  splitDocument,
  updateDocumentReporting,
} from "@/application/documents";
import type { ExtractionPayload, Party } from "@/application/extraction-payload";
import { retrySplit, uploadSourceFile } from "@/application/source-files";
import {
  assignCompanyAiConfiguration,
  createAiConfiguration,
  setDefaultAiConfiguration,
  setAiModelPrices,
  updateAiConfiguration,
} from "@/application/ai-configurations";
import { setCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import {
  setPlatformOrganizationBlocked,
  setPlatformUploadLimits,
} from "@/application/platform-administration";
import { retryFailedProcessingJob } from "@/application/processing-administration";
import {
  deleteUploadBatch,
  dismissCompanyUploadNotifications,
  dismissUploadNotification,
  markCompanyUploadNotificationsRead,
  markUploadBatchNotificationRead,
  markUploadNotificationRead,
} from "@/application/upload-batches";
import { configuredAresRegistry } from "@/ares";
import { configuredExchangeRates } from "@/cnb";
import { jobQueue } from "@/lib/jobs";
import { createRequestClient, requireUserClient } from "@/lib/supabase/server";
import { isLocale, localeCookie } from "@/i18n/locales";
import { companyContextCookie, serializeCompanyContext } from "@/lib/company-context";
import { normalizeDocumentQueueQuery } from "@/application/document-queue";
import { isUuid } from "@/application/client";

/**
 * Form state: an error code that the form translates through the `errors`
 * messages, plus the submitted values so a refused form keeps its input
 * (React resets forms after an action). Passwords are never echoed back.
 */
export type FormState = { error: string | null; values: Record<string, string> };

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "");

async function storeCompanyContext(companyId: string): Promise<boolean> {
  const client = await requireUserClient();
  const [user, company] = await Promise.all([
    currentUser(client),
    getCompany(client, companyId),
  ]);
  if (!user || !company) return false;
  (await cookies()).set(
    companyContextCookie,
    serializeCompanyContext({ userId: user.id, companyId }),
    { httpOnly: true, maxAge: 60 * 60 * 24 * 365, path: "/", sameSite: "lax" },
  );
  return true;
}

export async function rememberCompanyAction(companyId: string): Promise<void> {
  await storeCompanyContext(companyId);
}

export async function selectCompanyAction(formData: FormData): Promise<void> {
  const companyId = field(formData, "companyId");
  if (await storeCompanyContext(companyId)) redirect(`/companies/${companyId}`);
  redirect("/");
}

function refused(error: string, formData: FormData, fields: string[]): FormState {
  return { error, values: Object.fromEntries(fields.map((name) => [name, field(formData, name)])) };
}

const COMPANY_FIELDS = [
  "organizationId",
  "name",
  "firstName",
  "lastName",
  "ico",
  "vatId",
  "streetName",
  "houseNumber",
  "orientationNumber",
  "city",
  "postalCode",
  "personType",
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
    firstName: field(formData, "firstName"),
    lastName: field(formData, "lastName"),
    ico: field(formData, "ico"),
    vatId: field(formData, "vatId"),
    streetName: field(formData, "streetName"),
    houseNumber: field(formData, "houseNumber"),
    orientationNumber: field(formData, "orientationNumber"),
    city: field(formData, "city"),
    postalCode: field(formData, "postalCode"),
    personType: field(formData, "personType") as "legal" | "natural",
  };
  const client = await requireUserClient();
  if (companyId) {
    const result = await updateCompanyIdentity(client, { companyId, ...settings });
    if (!result.ok) return refused(result.error, formData, COMPANY_FIELDS);
    await storeCompanyContext(companyId);
    redirect(`/companies/${companyId}/settings`);
  }
  const result = await createCompanyIdentity(client, {
    organizationId: field(formData, "organizationId"),
    ...settings,
  });
  if (!result.ok) return refused(result.error, formData, COMPANY_FIELDS);
  await storeCompanyContext(result.value.id);
  redirect(`/companies/${result.value.id}/setup/filing-frequency`);
}

export async function setCurrentReportingYearAction(_state: FormState, formData: FormData): Promise<FormState> {
  const companyId = field(formData, "companyId");
  const result = await setCurrentReportingYear(await requireUserClient(), {
    companyId,
    filingFrequency: field(formData, "filingFrequency") as "monthly" | "quarterly",
  });
  if (!result.ok) return refused(result.error, formData, ["filingFrequency"]);
  redirect(`/companies/${companyId}/setup/ai-processing`);
}

const REPORTING_YEAR_FIELDS = ["fromYear", "toYear", "frequency"];

/** Returns the generated and skipped years so the form can report both. */
export async function generateReportingYearsAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await generateReportingYears(await requireUserClient(), {
    companyId: field(formData, "companyId"),
    fromYear: Number(field(formData, "fromYear")),
    toYear: Number(field(formData, "toYear") || field(formData, "fromYear")),
    frequency: field(formData, "frequency") as "monthly" | "quarterly",
  });
  if (!result.ok) return refused(result.error, formData, REPORTING_YEAR_FIELDS);
  refresh();
  return {
    error: null,
    values: {
      generated: result.value.generated.join(", "),
      skipped: result.value.skipped.join(", "),
    },
  };
}

export async function changeReportingYearFrequencyAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await changeReportingYearFrequency(await requireUserClient(), {
    companyId: field(formData, "companyId"),
    year: Number(field(formData, "year")),
    frequency: field(formData, "frequency") as "monthly" | "quarterly",
  });
  if (!result.ok) return refused(result.error, formData, ["frequency"]);
  return settled(result);
}

export async function setFirstReportingMonthAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await setFirstReportingMonth(await requireUserClient(), {
    companyId: field(formData, "companyId"),
    year: Number(field(formData, "year")),
    firstMonth: Number(field(formData, "firstMonth")),
  });
  if (!result.ok) return refused(result.error, formData, ["firstMonth"]);
  return settled(result);
}

export async function deleteReportingYearAction(_state: FormState, formData: FormData): Promise<FormState> {
  if (field(formData, "confirmed") !== "on") return refused("confirmation_required", formData, []);
  const result = await deleteReportingYear(await requireUserClient(), {
    companyId: field(formData, "companyId"),
    year: Number(field(formData, "year")),
  });
  if (!result.ok) return refused(result.error, formData, ["confirmed"]);
  return settled(result);
}

const FILING_DEFAULT_FIELDS = [
  "taxOffice",
  "territorialOffice",
  "economicActivity",
  "signatoryFirstName",
  "signatoryLastName",
  "signatoryCapacity",
  "email",
  "phone",
  "useEpoAddressOverride",
  "epoStreetName",
  "epoHouseNumber",
  "epoOrientationNumber",
  "epoCity",
  "epoPostalCode",
  "epoAddressConfirmed",
];

export async function saveCompanyFilingDefaultsAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const useEpoAddressOverride = field(formData, "useEpoAddressOverride") === "yes";
  const result = await saveCompanyFilingDefaults(await requireUserClient(), {
    companyId: field(formData, "companyId"),
    taxOffice: field(formData, "taxOffice"),
    territorialOffice: field(formData, "territorialOffice"),
    economicActivity: field(formData, "economicActivity"),
    signatoryFirstName: field(formData, "signatoryFirstName"),
    signatoryLastName: field(formData, "signatoryLastName"),
    signatoryCapacity: field(formData, "signatoryCapacity"),
    email: field(formData, "email"),
    phone: field(formData, "phone"),
    epoAddressOverride: useEpoAddressOverride ? {
      streetName: field(formData, "epoStreetName"),
      houseNumber: field(formData, "epoHouseNumber"),
      orientationNumber: field(formData, "epoOrientationNumber"),
      city: field(formData, "epoCity"),
      postalCode: field(formData, "epoPostalCode"),
    } : null,
    epoAddressConfirmed: field(formData, "epoAddressConfirmed") === "yes",
  });
  if (!result.ok) return refused(result.error, formData, FILING_DEFAULT_FIELDS);
  refresh();
  return {
    error: null,
    values: {
      ...Object.fromEntries(FILING_DEFAULT_FIELDS.map((name) => [name, field(formData, name)])),
      saved: "yes",
    },
  };
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

/** Runs when a User opens a batch's detail; refreshes the inbox badge in the shell. */
export async function markUploadBatchNotificationReadAction(batchId: string): Promise<void> {
  const result = await markUploadBatchNotificationRead(await requireUserClient(), batchId);
  if (result.ok && result.value.changed) refresh();
}

export async function deleteUploadBatchAction(_state: FormState, formData: FormData): Promise<FormState> {
  const companyId = field(formData, "companyId");
  if (field(formData, "confirmed") !== "on") return refused("confirmation_required", formData, []);
  const result = await deleteUploadBatch(await requireUserClient(), {
    companyId,
    batchId: field(formData, "batchId"),
  });
  if (!result.ok) return refused(result.error, formData, ["confirmed"]);
  redirect(`/companies/${companyId}/upload`);
}

export async function markUploadNotificationReadAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  return settled(
    await markUploadNotificationRead(
      await requireUserClient(),
      field(formData, "notificationId"),
    ),
  );
}

export async function markCompanyUploadNotificationsReadAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  return settled(
    await markCompanyUploadNotificationsRead(
      await requireUserClient(),
      field(formData, "companyId"),
    ),
  );
}

export async function dismissUploadNotificationAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  return settled(
    await dismissUploadNotification(
      await requireUserClient(),
      field(formData, "notificationId"),
    ),
  );
}

export async function dismissCompanyUploadNotificationsAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  return settled(
    await dismissCompanyUploadNotifications(
      await requireUserClient(),
      field(formData, "companyId"),
    ),
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
  const companyId = field(formData, "companyId");
  const documentId = field(formData, "documentId");
  const result = await approveDocument(await requireUserClient(), {
    companyId,
    documentId,
    version: Number(field(formData, "version")),
  });
  if (!result.ok) return settled(result);
  redirectAfterDocumentDecision(formData, companyId, documentId);
}

export async function rejectDocumentAction(_state: FormState, formData: FormData): Promise<FormState> {
  const companyId = field(formData, "companyId");
  const documentId = field(formData, "documentId");
  const result = await rejectDocument(await requireUserClient(), { companyId, documentId });
  if (!result.ok) return settled(result);
  redirectAfterDocumentDecision(formData, companyId, documentId);
}

export async function returnDocumentToReviewAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(
    await returnDocumentToReview(await requireUserClient(), {
      companyId: field(formData, "companyId"),
      documentId: field(formData, "documentId"),
    }),
  );
}

function redirectAfterDocumentDecision(formData: FormData, companyId: string, documentId: string): never {
  const query = normalizeDocumentQueueQuery(field(formData, "queueQuery"));
  const nextDocumentId = field(formData, "nextDocumentId");
  if (isUuid(nextDocumentId)) redirect(`/companies/${companyId}/documents/${nextDocumentId}?${query}`);
  redirect(`/companies/${companyId}/documents?${query}#document-${documentId}`);
}

export async function updateDocumentReportingAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await updateDocumentReporting(await requireUserClient(), {
    companyId: field(formData, "companyId"),
    documentId: field(formData, "documentId"),
    claimedReportingPeriod: optionalField(formData, "claimedReportingPeriod"),
  });
  if (!result.ok) {
    return refused(result.error, formData, ["claimedReportingPeriod"]);
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

export async function finalizeVatReportAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await finalizeVatReport(await requireUserClient(), {
    companyId: field(formData, "companyId"),
    period: field(formData, "period"),
    confirmed: field(formData, "confirmed") === "on",
  });
  if (!result.ok) return refused(result.error, formData, ["confirmed"]);
  refresh();
  return { error: null, values: {} };
}

export async function unlockReportingPeriodAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await unlockReportingPeriod(await requireUserClient(), {
    companyId: field(formData, "companyId"),
    period: field(formData, "period"),
    reason: field(formData, "reason"),
    confirmed: field(formData, "confirmed") === "on",
  });
  if (!result.ok) return refused(result.error, formData, ["reason", "confirmed"]);
  refresh();
  return { error: null, values: {} };
}

export async function inviteMemberAction(_state: FormState, formData: FormData): Promise<FormState> {
  const client = await requireUserClient();
  const urls = invitationUrls({
    appOrigin: process.env.APP_ORIGIN,
    authRedirectAllowlist: process.env.AUTH_REDIRECT_ALLOWLIST,
  });
  if (!urls.ok) return refused(urls.error, formData, ["email", "role"]);
  const result = await inviteMember(client, supabaseInvitationMailer(client, urls.value.callbackUrl), {
    organizationId: field(formData, "organizationId"),
    companyId: field(formData, "companyId") || null,
    email: field(formData, "email"),
    role: field(formData, "role") as "administrator" | "user",
    acceptUrl: urls.value.acceptUrl,
  });
  if (!result.ok) return refused(result.error, formData, ["email", "role"]);
  refresh();
  return { error: null, values: {} };
}

export async function acceptInvitationAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await completeInvitationOnboarding(await createRequestClient(), {
    token: field(formData, "token"),
    password: field(formData, "password"),
  });
  if (!result.ok) return refused(result.error, formData, []);
  if (result.value.companyId && await storeCompanyContext(result.value.companyId)) {
    redirect(`/companies/${result.value.companyId}`);
  }
  redirect("/");
}

export async function changeMembershipRoleAction(_state: FormState, formData: FormData): Promise<FormState> {
  const result = await changeMembershipRole(await requireUserClient(), {
    membershipId: field(formData, "membershipId"),
    role: field(formData, "role") as "administrator" | "user",
  });
  if (!result.ok) return refused(result.error, formData, ["role"]);
  return settled(result);
}

export async function removeMembershipAction(_state: FormState, formData: FormData): Promise<FormState> {
  return settled(await removeMembership(await requireUserClient(), field(formData, "membershipId")));
}

export async function createAiConfigurationAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await createAiConfiguration(await requireUserClient(), {
    label: field(formData, "label"),
    provider: field(formData, "provider"),
    splitModel: field(formData, "splitModel"),
    extractModel: field(formData, "extractModel"),
    credential: field(formData, "credential"),
  });
  // Credentials are never included in serialized Server Action state.
  if (!result.ok) return refused(result.error, formData, ["label", "provider", "splitModel", "extractModel"]);
  refresh();
  return { error: null, values: {} };
}

export async function updateAiConfigurationAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await updateAiConfiguration(await requireUserClient(), {
    id: field(formData, "configurationId"),
    label: field(formData, "label"),
    provider: field(formData, "provider"),
    splitModel: field(formData, "splitModel"),
    extractModel: field(formData, "extractModel"),
    credential: field(formData, "credential").trim() || undefined,
  }, jobQueue);
  if (!result.ok) return refused(result.error, formData, [
    "configurationId",
    "label",
    "provider",
    "splitModel",
    "extractModel",
  ]);
  refresh();
  return { error: null, values: {} };
}

/** An empty price is no price; a decimal comma is accepted. */
function priceField(value: FormDataEntryValue): number | null {
  const text = String(value).trim().replace(",", ".");
  return text === "" ? null : Number(text);
}

export async function setAiModelPricesAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const models = formData.getAll("model").map(String);
  const inputPrices = formData.getAll("inputPricePerMillion");
  const outputPrices = formData.getAll("outputPricePerMillion");
  const result = await setAiModelPrices(await requireUserClient(), {
    configurationId: field(formData, "configurationId"),
    prices: models.map((model, index) => ({
      model,
      inputPricePerMillion: priceField(inputPrices[index] ?? ""),
      outputPricePerMillion: priceField(outputPrices[index] ?? ""),
    })),
  });
  if (!result.ok) {
    return {
      error: result.error,
      values: Object.fromEntries(models.flatMap((model, index) => [
        [`inputPricePerMillion:${model}`, String(inputPrices[index] ?? "")],
        [`outputPricePerMillion:${model}`, String(outputPrices[index] ?? "")],
      ])),
    };
  }
  refresh();
  return { error: null, values: {} };
}

export async function assignCompanyAiConfigurationAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await assignCompanyAiConfiguration(await requireUserClient(), {
    companyId: field(formData, "companyId"),
    configurationId: field(formData, "configurationId"),
  }, jobQueue);
  if (!result.ok) return refused(result.error, formData, ["configurationId"]);
  refresh();
  return { error: null, values: {} };
}

export async function setCompanyAiProcessingAllowanceAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const unlimited = field(formData, "unlimited") === "on";
  const allowance = Number(field(formData, "allowance"));
  const result = await setCompanyAiProcessingAllowance(await requireUserClient(), jobQueue, {
    companyId: field(formData, "companyId"),
    allowance: unlimited ? null : allowance,
  });
  if (!result.ok) return refused(result.error, formData, ["allowance", "unlimited"]);
  refresh();
  return { error: null, values: {} };
}

export async function setDefaultAiConfigurationAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  return settled(await setDefaultAiConfiguration(
    await requireUserClient(),
    field(formData, "configurationId"),
  ));
}

export async function setPlatformOrganizationBlockedAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  return settled(await setPlatformOrganizationBlocked(await requireUserClient(), {
    organizationId: field(formData, "organizationId"),
    blocked: field(formData, "blocked") === "true",
  }));
}

export async function setPlatformUploadLimitsAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await setPlatformUploadLimits(await requireUserClient(), {
    maxFileBytes: Number(field(formData, "maxFileBytes")),
    maxFilePages: Number(field(formData, "maxFilePages")),
    maxBatchFiles: Number(field(formData, "maxBatchFiles")),
  });
  if (!result.ok) return refused(result.error, formData, ["maxFileBytes", "maxFilePages", "maxBatchFiles"]);
  refresh();
  return { error: null, values: {} };
}

export async function retryFailedProcessingJobAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  return settled(await retryFailedProcessingJob(
    await requireUserClient(),
    field(formData, "jobId"),
  ));
}
