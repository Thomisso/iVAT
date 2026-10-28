import fs from "node:fs";
import path from "node:path";
import type { Result } from "./client";
import type { ComputedVatReport } from "./vat-rules";

import {
  parseExportDetails,
  type EpoFormat,
  type ExportDetails,
} from "./epo-export-details";
export type { EpoFormat, ExportDetails } from "./epo-export-details";

export type EpoXmlError = "invalid_export_details" | "xml_invalid";

/** Exact rounding of a summed line to whole CZK, half away from zero. */
function wholeCzk(value: string): bigint {
  const minor = BigInt(value.replace(".", ""));
  const absolute = minor < BigInt(0) ? -minor : minor;
  const rounded = (absolute + BigInt(50)) / BigInt(100);
  return minor < BigInt(0) ? -rounded : rounded;
}
function exactSum(values: string[]): string {
  const minor = values.reduce(
    (sum, value) => sum + BigInt(value.replace(".", "")),
    BigInt(0),
  );
  const absolute = minor < BigInt(0) ? -minor : minor;
  return `${minor < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}
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
  return element("VetaP", {
    c_ufo: details.taxOffice,
    ...(details.taxOffice === "13" ? { c_pracufo: "4000" } : {}),
    dic: c.vatId.replace(/^CZ/, ""),
    typ_ds: details.personType,
    ...(details.personType === "P"
      ? { zkrobchjm: c.name }
      : { jmeno: c.firstName ?? undefined, prijmeni: c.lastName ?? undefined }),
    ulice: c.streetName,
    c_pop: c.houseNumber,
    c_orient: c.orientationNumber ?? undefined,
    naz_obce: c.city,
    psc: c.postalCode.replace(/\s/g, ""),
    stat: "ČESKÁ REPUBLIKA",
    email: details.email || undefined,
    ...(details.personType === "P"
      ? {
          opr_jmeno: details.signatoryFirstName,
          opr_prijmeni: details.signatoryLastName,
          opr_postaveni: details.signatoryCapacity,
        }
      : {}),
  });
}
function vatReturn(report: ComputedVatReport): string[] {
  const line = (number: string) =>
    report.vatReturn.find((line) => line.line === number)!;
  const net = (n: string) => String(wholeCzk(line(n).netAmount));
  const vat = (n: string) => String(wholeCzk(line(n).vatAmount));
  const total = (numbers: string[], field: "netAmount" | "vatAmount") =>
    numbers.reduce((sum, number) => sum + wholeCzk(line(number)[field]), BigInt(0));
  const output = total(["1", "2", "3", "4", "5", "6", "10", "11"], "vatAmount");
  const input = total(["40", "41", "43", "44"], "vatAmount");
  const rows = [
    element("Veta1", {
      obrat23: net("1"),
      dan23: vat("1"),
      obrat5: net("2"),
      dan5: vat("2"),
      ...(line("3").documentIds.length ? { p_zb23: net("3"), dan_pzb23: vat("3") } : {}),
      ...(line("4").documentIds.length ? { p_zb5: net("4"), dan_pzb5: vat("4") } : {}),
      ...(line("5").documentIds.length ? { p_sl23_e: net("5"), dan_psl23_e: vat("5") } : {}),
      ...(line("6").documentIds.length ? { p_sl5_e: net("6"), dan_psl5_e: vat("6") } : {}),
      ...(line("10").documentIds.length ? { rez_pren23: net("10"), dan_rpren23: vat("10") } : {}),
      ...(line("11").documentIds.length ? { rez_pren5: net("11"), dan_rpren5: vat("11") } : {}),
    }),
    element("Veta4", {
      pln23: net("40"),
      odp_tuz23_nar: vat("40"),
      pln5: net("41"),
      odp_tuz5_nar: vat("41"),
      ...(line("43").documentIds.length ? { nar_zdp23: net("43"), od_zdp23: vat("43") } : {}),
      ...(line("44").documentIds.length ? { nar_zdp5: net("44"), od_zdp5: vat("44") } : {}),
      odp_sum_nar: String(input),
    }),
    element("Veta6", {
      dan_zocelk: String(output),
      odp_zocelk: String(input),
      ...(output >= input
        ? { dano_da: String(output - input) }
        : { dano_no: String(input - output) }),
    }),
  ];
  if (line("25").documentIds.length) {
    rows.splice(1, 0, element("Veta2", { pln_rez_pren: net("25") }));
  }
  return rows;
}

function controlStatement(report: ComputedVatReport): string[] {
  const result: string[] = [];
  for (const section of ["A.1", "A.2", "A.4", "A.5", "B.1", "B.2", "B.3"] as const) {
    let row = 0;
    for (const entry of report.controlStatement.filter(
      (entry) => entry.section === section,
    )) {
      const attributes: Record<string, string> = {};
      if (section === "A.1") {
        attributes.c_radku = String(++row);
        attributes.dic_odb = entry.counterpartyVatId!.replace(/^CZ/, "");
        attributes.c_evid_dd = entry.documentNumber!;
        attributes.duzp = epoDate(entry.taxPointDate!);
        attributes.zakl_dane1 = exactSum(entry.rateBreakdown.map((rate) => rate.netAmount));
        attributes.kod_pred_pl = entry.reverseChargeCode!;
      } else if (section === "A.2") {
        attributes.c_radku = String(++row);
        if (entry.counterpartyCountry) attributes.k_stat = entry.counterpartyCountry;
        if (entry.counterpartyVatId) attributes.vatid_dod = entry.counterpartyVatId.slice(2);
        attributes.c_evid_dd = entry.documentNumber!;
        attributes.dppd = epoDate(entry.taxPointDate!);
      } else if (section === "B.1") {
        attributes.c_radku = String(++row);
        attributes.dic_dod = entry.counterpartyVatId!.replace(/^CZ/, "");
        attributes.c_evid_dd = entry.documentNumber!;
        attributes.duzp = epoDate(entry.taxPointDate!);
        attributes.kod_pred_pl = entry.reverseChargeCode!;
      } else if (section === "A.4" || section === "B.2") {
        attributes.c_radku = String(++row);
        attributes[section === "A.4" ? "dic_odb" : "dic_dod"] =
          entry.counterpartyVatId!.replace(/^CZ/, "");
        attributes.c_evid_dd = entry.documentNumber!;
        attributes.dppd = epoDate(entry.taxPointDate!);
        if (section === "A.4") attributes.kod_rezim_pl = "0";
        else attributes.pomer = "N";
        attributes.zdph_44 = "N";
      }
      if (section !== "A.1") {
        for (const rate of [...entry.rateBreakdown].sort(
          (a, b) => b.rate - a.rate,
        )) {
          const index = rate.rate === 21 ? "1" : "2";
          attributes[`zakl_dane${index}`] = rate.netAmount;
          attributes[`dan${index}`] = rate.vatAmount;
        }
      }
      result.push(element(`Veta${section.replace(".", "")}`, attributes));
    }
  }
  const net = (line: string) =>
    report.vatReturn.find((entry) => entry.line === line)!.netAmount;
  const has = (line: string) =>
    report.vatReturn.find((entry) => entry.line === line)!.documentIds.length > 0;
  result.push(
    element("VetaC", {
      obrat23: net("1"),
      obrat5: net("2"),
      pln23: net("40"),
      pln5: net("41"),
      ...(has("25") ? { pln_rez_pren: net("25") } : {}),
      ...(has("10") ? { rez_pren23: net("10") } : {}),
      ...(has("11") ? { rez_pren5: net("11") } : {}),
      ...(has("3") || has("4") || has("5") || has("6")
        ? { celk_zd_a2: exactSum(["3", "4", "5", "6"].map(net)) }
        : {}),
    }),
  );
  return result;
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
  const parsed = parseExportDetails(details);
  if (!parsed.ok) return parsed;
  details = parsed.value;
  const [year, periodPart] = report.period.split("-");
  const quarter = /^Q([1-4])$/.exec(periodPart)?.[1];
  const isReturn = format === "dphdp3";
  const name = isReturn ? "DPHDP3" : "DPHKH1";
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Pisemnost nazevSW="iVAT" verzeSW="0.1.0">',
    `  <${name} verzePis="${isReturn ? "03.01.04" : "03.01.15"}">`,
    element("VetaD", {
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
    ...(isReturn ? vatReturn(report) : controlStatement(report)),
    `  </${name}>`,
    "</Pisemnost>",
    "",
  ].join("\n");
  return (await validateEpoXml(xml, format))
    ? { ok: true, value: xml }
    : { ok: false, error: "xml_invalid" };
}
