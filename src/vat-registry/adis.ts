import type {
  VatPayerRegistry,
  VatPayerRegistryCheck,
} from "@/application/vat-registry";

const ENDPOINT =
  "https://adisrws.mfcr.cz/dpr/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP";
const NAMESPACE = "http://adis.mfcr.cz/rozhraniCRPDPH/";

type Attributes = Record<string, string>;

function attributes(source: string): Attributes {
  const result: Attributes = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) {
    result[match[1]] = match[3];
  }
  return result;
}

function tags(xml: string, localName: string): Attributes[] {
  const expression = new RegExp(
    `<(?:[\\w-]+:)?${localName}\\b([^>]*)>`,
    "g",
  );
  return [...xml.matchAll(expression)].map((match) => attributes(match[1]));
}

function parseResponse(xml: string): VatPayerRegistryCheck {
  const status = tags(xml, "status")[0];
  if (!status || status.statusCode !== "0") {
    return { outcome: "unavailable" };
  }
  const payer = tags(xml, "statusPlatceDPH")[0];
  if (!payer?.nespolehlivyPlatce) return { outcome: "unavailable" };
  if (payer.nespolehlivyPlatce === "NENALEZEN") {
    return { outcome: "not_found" };
  }
  if (
    payer.nespolehlivyPlatce !== "ANO" &&
    payer.nespolehlivyPlatce !== "NE"
  ) {
    return { outcome: "unavailable" };
  }
  const standardAccounts = tags(xml, "standardniUcet").flatMap((account) => {
    if (!account.cislo || !account.kodBanky) return [];
    return [
      `${account.predcisli ? `${account.predcisli}-` : ""}${account.cislo}/${account.kodBanky}`,
    ];
  });
  const nonStandardAccounts = tags(xml, "nestandardniUcet").flatMap(
    (account) => (account.cislo ? [account.cislo] : []),
  );
  return {
    outcome: "checked",
    unreliable: payer.nespolehlivyPlatce === "ANO",
    publishedAccounts: [...standardAccounts, ...nonStandardAccounts],
  };
}

function request(vatId: string): string {
  const dic = vatId.replace(/^CZ/, "");
  return [
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">`,
    "<soapenv:Body>",
    `<StatusNespolehlivyPlatceRequest xmlns="${NAMESPACE}">`,
    `<dic>${dic}</dic>`,
    "</StatusNespolehlivyPlatceRequest>",
    "</soapenv:Body>",
    "</soapenv:Envelope>",
  ].join("");
}

/** The official Czech Financial Administration SOAP adapter. */
export function adisVatPayerRegistry(
  fetcher: typeof fetch = fetch,
): VatPayerRegistry {
  return {
    async check(vatId) {
      try {
        const response = await fetcher(ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "text/xml; charset=utf-8",
            SOAPAction: `${NAMESPACE}getStatusNespolehlivyPlatce`,
          },
          body: request(vatId),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return { outcome: "unavailable" };
        return parseResponse(await response.text());
      } catch {
        return { outcome: "unavailable" };
      }
    },
  };
}
