import fs from "node:fs";
import path from "node:path";
import type { Result } from "./client";
import type { ComputedVatReport } from "./vat-rules";
import { prepareVatReturn, prepareControlStatement } from "./epo-values";
import { xmlGeneratorVersion } from "@/lib/release-identity";

import {
  parseExportDetails,
  type EpoFormat,
  type ExportDetails,
} from "./epo-export-details";
export type { EpoFormat, ExportDetails } from "./epo-export-details";

export type EpoXmlError = "invalid_export_details" | "xml_invalid";

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;");
}
function element(
  name: string,
  attributes: Record<string, string | undefined>,
): string {
  return `    <${name}${Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value!)}"`)
    .join("")}/>`;
}
function epoDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}
function party(report: ComputedVatReport, details: ExportDetails): string {
  const c = report.company;
  const address = details.address ?? c;
  return element("VetaP", {
    c_ufo: details.taxOffice,
    c_pracufo: details.territorialOffice || undefined,
    dic: c.vatId.replace(/^CZ/, ""),
    typ_ds: details.personType,
    ...(details.personType === "P"
      ? { zkrobchjm: c.name }
      : { jmeno: c.firstName ?? undefined, prijmeni: c.lastName ?? undefined }),
    ulice: address.streetName,
    c_pop: address.houseNumber,
    c_orient: address.orientationNumber ?? undefined,
    naz_obce: address.city,
    psc: address.postalCode.replace(/\s/g, ""),
    stat: "ČESKÁ REPUBLIKA",
    email: details.email || undefined,
    c_telef: details.phone || undefined,
    ...(details.personType === "P"
      ? {
          opr_jmeno: details.signatoryFirstName,
          opr_prijmeni: details.signatoryLastName,
          opr_postaveni: details.signatoryCapacity,
        }
      : {}),
  });
}
/** Validates each candidate against the unmodified vendored official schema. */
export async function validateEpoXml(
  xml: string,
  format: EpoFormat,
): Promise<boolean> {
  const {
    XmlDocument,
    XsdValidator,
    XmlValidateError,
    XmlParseError,
    ParseOption,
  } = await import("libxml2-wasm");
  const schema = XmlDocument.fromString(
    fs.readFileSync(
      path.join(process.cwd(), "schemas", "epo", `${format}_epo2.xsd`),
      "utf8",
    ),
    { option: ParseOption.XML_PARSE_NO_XXE },
  );
  try {
    const validator = XsdValidator.fromDoc(schema);
    try {
      let document;
      try {
        document = XmlDocument.fromString(xml, {
          option: ParseOption.XML_PARSE_NO_XXE,
        });
        validator.validate(document);
        return true;
      } catch (error) {
        if (error instanceof XmlValidateError || error instanceof XmlParseError)
          return false;
        throw error;
      } finally {
        document?.dispose();
      }
    } finally {
      validator.dispose();
    }
  } finally {
    schema.dispose();
  }
}

/** Export the stored draft, never the Company's subsequently changed Documents. */
export async function createEpoXml(
  report: ComputedVatReport,
  format: EpoFormat,
  details: ExportDetails,
): Promise<Result<string, EpoXmlError>> {
  const parsed = parseExportDetails({
    taxOffice: details.taxOffice,
    territorialOffice: details.territorialOffice,
    economicActivity: details.economicActivity,
    preparedOn: details.preparedOn,
    email: details.email,
    phone: details.phone,
    personType: details.personType,
    ...(details.personType === "P" ? {
      signatoryFirstName: details.signatoryFirstName,
      signatoryLastName: details.signatoryLastName,
      signatoryCapacity: details.signatoryCapacity,
    } : {}),
  }, format);
  if (!parsed.ok) return parsed;
  details = { ...parsed.value, address: details.address };
  const [year, periodPart] = report.period.split("-");
  const quarter = /^Q([1-4])$/.exec(periodPart)?.[1];
  const isReturn = format === "dphdp3";
  const name = isReturn ? "DPHDP3" : "DPHKH1";
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Pisemnost nazevSW="iVAT" verzeSW="${escapeAttribute(xmlGeneratorVersion)}">`,
    `  <${name} verzePis="${isReturn ? "03.01.04" : "03.01.15"}">`,
    element("VetaD", {
      ...(isReturn ? { c_okec: details.economicActivity } : {}),
      dokument: isReturn ? "DP3" : "KH1",
      k_uladis: "DPH",
      ...(isReturn
        ? { dapdph_forma: "B", typ_platce: "P" }
        : { khdph_forma: "B" }),
      rok: year,
      ...(quarter
        ? { ctvrt: quarter }
        : { mesic: String(Number(periodPart)) }),
      d_poddp: epoDate(details.preparedOn),
      ...(isReturn
        ? {
            trans: report.vatReturn.some((line) => line.documentIds.length)
              ? "A"
              : "N",
          }
        : {}),
    }),
    party(report, details),
    ...(isReturn ? prepareVatReturn(report).rows : prepareControlStatement(report)).map(row => element(row.name, row.attributes)),
    `  </${name}>`,
    "</Pisemnost>",
    "",
  ].join("\n");
  return (await validateEpoXml(xml, format))
    ? { ok: true, value: xml }
    : { ok: false, error: "xml_invalid" };
}
