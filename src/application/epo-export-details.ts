import type { Result } from "./client";
import { isEconomicActivity, isTerritorialOffice } from "./epo-catalogues";

export const EPO_FORMATS = ["dphdp3", "dphkh1"] as const;
export type EpoFormat = (typeof EPO_FORMATS)[number];
export const isEpoFormat = (value: string): value is EpoFormat =>
  EPO_FORMATS.some((format) => format === value);
// Official technical c_ufo codes; source and retrieval date: schemas/epo/README.md.
export const TAX_OFFICES = [
  "451",
  "452",
  "453",
  "454",
  "455",
  "456",
  "457",
  "458",
  "459",
  "460",
  "461",
  "462",
  "463",
  "464",
  "13",
] as const;
export type ExportDetails = {
  taxOffice: string;
  territorialOffice: string;
  economicActivity: string;
  preparedOn: string;
  email: string;
  phone: string;
  address?: {
    streetName: string;
    houseNumber: string;
    orientationNumber: string | null;
    city: string;
    postalCode: string;
  };
} & (
  | {
      personType: "P";
      signatoryFirstName: string;
      signatoryLastName: string;
      signatoryCapacity: string;
    }
  | { personType: "F" }
);

/** Validates the resolved direct-filing details at the final server-side seam. */
export function parseExportDetails(
  input: Record<string, string>,
  format: EpoFormat = "dphdp3",
): Result<ExportDetails, "invalid_export_details"> {
  const value = (key: string) => input[key]?.trim() ?? "";
  const bounded = (key: string, max: number) =>
    value(key).length > 0 && value(key).length <= max;
  const date = value("preparedOn");
  const validDate =
    /^20\d{2}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  const email = value("email");
  const phone = value("phone");
  const refused = { ok: false, error: "invalid_export_details" } as const;
  if (
    !TAX_OFFICES.some((code) => code === value("taxOffice")) ||
    (Boolean(value("territorialOffice")) && !isTerritorialOffice(value("taxOffice"), value("territorialOffice"))) ||
    (format === "dphdp3" && !value("economicActivity")) ||
    (Boolean(value("economicActivity")) && !isEconomicActivity(value("economicActivity"))) ||
    !validDate ||
    email.length > 255 ||
    (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
    phone.length > 14
  )
    return refused;
  const common = { taxOffice: value("taxOffice"), territorialOffice: value("taxOffice") === "13" ? "4000" : value("territorialOffice"), economicActivity: value("economicActivity"), preparedOn: date, email, phone };
  if (
    value("personType") === "P" &&
    bounded("signatoryFirstName", 20) &&
    bounded("signatoryLastName", 36) &&
    bounded("signatoryCapacity", 40)
  ) {
    return {
      ok: true,
      value: {
        ...common,
        personType: "P",
        signatoryFirstName: value("signatoryFirstName"),
        signatoryLastName: value("signatoryLastName"),
        signatoryCapacity: value("signatoryCapacity"),
      },
    };
  }
  if (value("personType") === "F")
    return {
      ok: true,
      value: {
        ...common,
        personType: "F",
      },
    };
  return refused;
}
