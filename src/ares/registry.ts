import type { AresRegistry, AresCompanyDetails } from "@/application/ares";

const OFFICIAL_BASE_URL =
  "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty";

type AresResponse = {
  ico?: unknown;
  obchodniJmeno?: unknown;
  dic?: unknown;
  pravniForma?: unknown;
  sidlo?: {
    nazevUlice?: unknown;
    nazevCastiObce?: unknown;
    cisloDomovni?: unknown;
    cisloOrientacni?: unknown;
    nazevObce?: unknown;
    psc?: unknown;
  };
};

type RzpResponse = {
  icoId?: unknown;
  zaznamy?: {
    ico?: unknown;
    primarniZaznam?: unknown;
    osobaPodnikatel?: { jmeno?: unknown; prijmeni?: unknown };
  }[];
};

// ARES PravniForma (res), verified 2026-10-30. Unknown/ambiguous forms stay editable.
const NATURAL_PERSON_FORMS = ["101", "102", "103", "104", "105", "106", "107", "108", "424", "425"];
const LEGAL_PERSON_FORMS = [
  "111", "112", "113", "114", "115", "116", "117", "118", "121", "131", "141", "145", "151", "161",
  "201", "205", "211", "231", "232", "233", "234", "241", "242", "251", "261", "301", "311", "312",
  "313", "314", "331", "343", "351", "352", "353", "361", "381", "391", "401", "411", "431", "432",
  "435", "436", "437", "438", "441", "442", "601", "641", "661", "671", "701", "702", "703", "704",
  "705", "706", "707", "708", "711", "715", "721", "722", "723", "736", "741", "745", "751", "761",
  "771", "801", "804", "805", "906", "907", "908", "921", "931", "932", "933", "936", "937", "938",
  "941", "951", "952", "960",
];

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberText(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return nonEmpty(value);
}

function companyDetails(payload: AresResponse): AresCompanyDetails | null {
  const ico = nonEmpty(payload.ico);
  const name = nonEmpty(payload.obchodniJmeno);
  const address = payload.sidlo;
  const streetName = nonEmpty(address?.nazevUlice) ?? nonEmpty(address?.nazevCastiObce);
  const houseNumber = numberText(address?.cisloDomovni);
  const orientationNumber = numberText(address?.cisloOrientacni);
  const city = nonEmpty(address?.nazevObce);
  const rawPostalCode = numberText(address?.psc)?.replace(/\s+/g, "");
  if (!ico) {
    return null;
  }
  return {
    name: name ?? "",
    ico,
    vatId: nonEmpty(payload.dic) ?? "",
    streetName: streetName ?? "",
    houseNumber: houseNumber ?? "",
    orientationNumber: orientationNumber ?? "",
    city: city ?? "",
    postalCode: /^\d{5}$/.test(rawPostalCode ?? "")
      ? `${rawPostalCode!.slice(0, 3)} ${rawPostalCode!.slice(3)}` : "",
    ...(NATURAL_PERSON_FORMS.includes(nonEmpty(payload.pravniForma) ?? "")
      ? { personType: "natural" as const }
      : LEGAL_PERSON_FORMS.includes(nonEmpty(payload.pravniForma) ?? "")
        ? { personType: "legal" as const } : {}),
  };
}

export function aresRegistry(fetcher: typeof fetch = fetch): AresRegistry {
  const baseUrl = process.env.ARES_BASE_URL ?? OFFICIAL_BASE_URL;
  async function entrepreneur(ico: string): Promise<Pick<AresCompanyDetails, "firstName" | "lastName">> {
    try {
      const response = await fetcher(`${baseUrl.replace(/\/ekonomicke-subjekty\/?$/, "/ekonomicke-subjekty-rzp")}/${encodeURIComponent(ico)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return {};
      const payload = await response.json() as RzpResponse;
      if (payload.icoId !== ico || !Array.isArray(payload.zaznamy)) return {};
      const records = payload.zaznamy.filter((record) => record.ico === ico && record.primarniZaznam === true);
      if (records.length !== 1) return {};
      const person = records[0].osobaPodnikatel;
      const firstName = nonEmpty(person?.jmeno);
      const lastName = nonEmpty(person?.prijmeni);
      return { ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}) };
    } catch {
      return {};
    }
  }
  return {
    async findByIco(ico) {
      try {
        const response = await fetcher(`${baseUrl}/${encodeURIComponent(ico)}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(5_000),
        });
        if (response.status === 404) {
          return { ok: false, error: "ares_company_not_found" };
        }
        if (!response.ok) return { ok: false, error: "ares_unavailable" };
        const details = companyDetails((await response.json()) as AresResponse);
        if (!details || details.ico !== ico) return { ok: false, error: "ares_unavailable" };
        if (details.personType === "natural") Object.assign(details, await entrepreneur(ico));
        return { ok: true, value: details };
      } catch {
        return { ok: false, error: "ares_unavailable" };
      }
    },
  };
}
