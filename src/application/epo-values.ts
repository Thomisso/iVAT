import type { ComputedVatReport } from "./vat-rules";
import { isZeroRateBreakdownLine } from "./extraction-payload";

/** Technical EPO field names shared by XML and form filling; omitted optional
 * values stay absent instead of turning into zero. */
export type EpoRow = { name: string; attributes: Record<string, string | undefined> };
function element(name: string, attributes: EpoRow["attributes"]): EpoRow {
  return { name, attributes };
}
function epoDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}.${month}.${year}`;
}

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
export function prepareVatReturn(report: ComputedVatReport) {
  const lines = report.vatReturn.map(line => ({ ...line,
    netAmount: String(wholeCzk(line.netAmount)), vatAmount: String(wholeCzk(line.vatAmount)),
  }));
  const line = (number: string) =>
    lines.find((line) => line.line === number)!;
  const net = (n: string) => line(n).netAmount;
  const vat = (n: string) => line(n).vatAmount;
  const total = (numbers: string[], field: "netAmount" | "vatAmount") =>
    numbers.reduce((sum, number) => sum + BigInt(line(number)[field]), BigInt(0));
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
  return { lines, totals: {
    outputVat: String(output), inputVat: String(input),
    payable: String(output >= input ? output - input : 0),
    excessDeduction: String(input > output ? input - output : 0),
  }, rows };
}

export function prepareControlStatement(report: ComputedVatReport): EpoRow[] {
  const result: EpoRow[] = [];
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
        for (const rate of entry.rateBreakdown.filter((rate) => !isZeroRateBreakdownLine(rate)).sort(
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

