import { describe, expect, it, vi } from "vitest";
import { adisVatPayerRegistry } from "@/vat-registry/adis";

const response = (body: string, init?: ResponseInit) =>
  new Response(body, { status: 200, ...init });

describe("ADIS VAT payer registry adapter", () => {
  it("sends the documented SOAP request and reads reliability and published accounts", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response(`
        <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
          <soapenv:Body>
            <StatusNespolehlivyPlatceResponse xmlns="http://adis.mfcr.cz/rozhraniCRPDPH/">
              <status odpovedGenerovana="2026-10-28" statusCode="0" statusText="OK" />
              <statusPlatceDPH cisloFu="451" dic="27082440" nespolehlivyPlatce="ANO">
                <zverejneneUcty>
                  <ucet datumZverejneni="2020-01-01">
                    <standardniUcet cislo="2000145399" kodBanky="0800" predcisli="19" />
                  </ucet>
                  <ucet datumZverejneni="2020-01-01">
                    <nestandardniUcet cislo="CZ6508000000192000145399" />
                  </ucet>
                </zverejneneUcty>
              </statusPlatceDPH>
            </StatusNespolehlivyPlatceResponse>
          </soapenv:Body>
        </soapenv:Envelope>
      `),
    );

    await expect(adisVatPayerRegistry(fetcher).check("CZ27082440")).resolves.toEqual({
      outcome: "checked",
      unreliable: true,
      publishedAccounts: ["19-2000145399/0800", "CZ6508000000192000145399"],
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe(
      "https://adisrws.mfcr.cz/dpr/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP",
    );
    expect(request?.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction:
          "http://adis.mfcr.cz/rozhraniCRPDPH/getStatusNespolehlivyPlatce",
      }),
    );
    expect(request?.body).toContain("<dic>27082440</dic>");
  });

  it("maps a missing payer separately from an outage", async () => {
    const missing = adisVatPayerRegistry(async () =>
      response(`
        <StatusNespolehlivyPlatceResponse>
          <status statusCode="0" statusText="OK" />
          <statusPlatceDPH dic="27082440" nespolehlivyPlatce="NENALEZEN" />
        </StatusNespolehlivyPlatceResponse>
      `),
    );
    const maintenance = adisVatPayerRegistry(async () =>
      response(`<StatusNespolehlivyPlatceResponse><status statusCode="2" /></StatusNespolehlivyPlatceResponse>`),
    );

    await expect(missing.check("CZ27082440")).resolves.toEqual({
      outcome: "not_found",
    });
    await expect(maintenance.check("CZ27082440")).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("turns transport and malformed-response failures into unavailable", async () => {
    const networkFailure = adisVatPayerRegistry(async () => {
      throw new Error("offline");
    });
    const malformed = adisVatPayerRegistry(async () => response("not xml"));

    await expect(networkFailure.check("CZ27082440")).resolves.toEqual({
      outcome: "unavailable",
    });
    await expect(malformed.check("CZ27082440")).resolves.toEqual({
      outcome: "unavailable",
    });
  });
});
