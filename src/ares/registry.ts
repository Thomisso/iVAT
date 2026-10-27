import type { AresRegistry, AresCompanyDetails } from "@/application/ares";

const BASE_URL =
  "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty";

type AresResponse = {
  ico?: unknown;
  obchodniJmeno?: unknown;
  dic?: unknown;
  sidlo?: {
    nazevUlice?: unknown;
    nazevCastiObce?: unknown;
    cisloDomovni?: unknown;
    cisloOrientacni?: unknown;
    nazevObce?: unknown;
    psc?: unknown;
  };
};

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
  if (!ico || !name || !streetName || !houseNumber || !city || !/^\d{5}$/.test(rawPostalCode ?? "")) {
    return null;
  }
  return {
    name,
    ico,
    vatId: nonEmpty(payload.dic) ?? "",
    street: `${streetName} ${houseNumber}${orientationNumber ? `/${orientationNumber}` : ""}`,
    city,
    postalCode: `${rawPostalCode!.slice(0, 3)} ${rawPostalCode!.slice(3)}`,
  };
}

export function aresRegistry(fetcher: typeof fetch = fetch): AresRegistry {
  return {
    async findByIco(ico) {
      try {
        const response = await fetcher(`${BASE_URL}/${encodeURIComponent(ico)}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(5_000),
        });
        if (response.status === 404) {
          return { ok: false, error: "ares_company_not_found" };
        }
        if (!response.ok) return { ok: false, error: "ares_unavailable" };
        const details = companyDetails((await response.json()) as AresResponse);
        return details
          ? { ok: true, value: details }
          : { ok: false, error: "ares_unavailable" };
      } catch {
        return { ok: false, error: "ares_unavailable" };
      }
    },
  };
}
