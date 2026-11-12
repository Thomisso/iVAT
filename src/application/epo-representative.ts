import type { Result } from "./client";

/** Supported representation data, independent of the taxpayer and export author. */
export type Representative = {
  code: "4a";
  personType: "F";
  firstName: string;
  lastName: string;
  birthDate: string;
  evidenceNumber: string;
};
export type RepresentativeError = "invalid_representative";
function calendarDate(value: string) {
  return /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
/** Incomplete review previews remain possible; unsupported kinds never fall back. */
export function parseRepresentative(input: unknown, complete = true): Result<Representative | null, RepresentativeError> {
  if (input == null) return { ok: true, value: null };
  const refused = { ok: false, error: "invalid_representative" } as const;
  if (typeof input !== "object" || Array.isArray(input)) return refused;
  const raw = input as Record<string, unknown>;
  const text = (key: string) => typeof raw[key] === "string" ? raw[key].trim() : "";
  if (["firstName", "lastName", "birthDate", "evidenceNumber"].some(key => raw[key] !== undefined && typeof raw[key] !== "string")) return refused;
  if (raw.code !== "4a" || raw.personType !== "F") return refused;
  const value: Representative = { code: "4a", personType: "F", firstName: text("firstName"), lastName: text("lastName"), birthDate: text("birthDate"), evidenceNumber: text("evidenceNumber") };
  if (value.firstName.length > 20 || value.lastName.length > 36 || value.evidenceNumber.length > 36
    || (value.birthDate && !calendarDate(value.birthDate))
    || (complete && (!value.firstName || !value.lastName || (!value.birthDate && !value.evidenceNumber)))) return refused;
  return { ok: true, value };
}
export function representativeFields(representative: Representative | null | undefined): Record<string, string> {
  return representative ? { representativeMode: "override", representativeCode: representative.code, representativePersonType: representative.personType,
    representativeFirstName: representative.firstName, representativeLastName: representative.lastName,
    representativeBirthDate: representative.birthDate, representativeEvidenceNumber: representative.evidenceNumber } : { representativeMode: "off" };
}
export function resolveRepresentative(input: Record<string, string>, fallback: Representative | null | undefined): Result<Representative | null, RepresentativeError> {
  const mode = input.representativeMode;
  if (mode === "off") return { ok: true, value: null };
  if (mode === "default" || mode === undefined) {
    if (mode === undefined && Object.entries(input).some(([key, value]) => key.startsWith("representative") && value)) return { ok: false, error: "invalid_representative" };
    return parseRepresentative(fallback, false);
  }
  if (mode !== "override") return { ok: false, error: "invalid_representative" };
  return parseRepresentative({ code: input.representativeCode, personType: input.representativePersonType,
    firstName: input.representativeFirstName, lastName: input.representativeLastName,
    birthDate: input.representativeBirthDate, evidenceNumber: input.representativeEvidenceNumber }, false);
}
