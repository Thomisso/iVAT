import { expect, it } from "vitest";
import {
  prefillCompanyFromAres,
  type AresRegistry,
} from "@/application/ares";
import { aresRegistry } from "@/ares/registry";

it("prefills the legal-person type from the ARES legal form", async () => {
  const result = await prefillCompanyFromAres(aresRegistry(async () => Response.json({
    ico: "27082440", obchodniJmeno: "ARES s.r.o.", pravniForma: "112",
  })), "27082440");
  expect(result).toEqual({ ok: true, value: expect.objectContaining({
    name: "ARES s.r.o.", personType: "legal", streetName: "",
  }) });
});

it("uses the primary RŽP entrepreneur's structured identity, never its officers or business name", async () => {
  const result = await prefillCompanyFromAres(aresRegistry(async (url) => Response.json(
    String(url).includes("ekonomicke-subjekty-rzp/") ? {
      icoId: "12345678", zaznamy: [
        { ico: "12345678", primarniZaznam: false, osobaPodnikatel: { jmeno: "Old", prijmeni: "Record" } },
        { ico: "12345678", primarniZaznam: true, osobaPodnikatel: { jmeno: "Marie Anna", prijmeni: "Nováková" },
          angazovaneOsoby: [{ jmeno: "Different", prijmeni: "Person" }] },
      ],
    } : { ico: "12345678", obchodniJmeno: "Ing. Marie Anna Nováková - studio", pravniForma: "101" },
  )), "12345678");
  expect(result).toEqual({ ok: true, value: expect.objectContaining({
    personType: "natural", firstName: "Marie Anna", lastName: "Nováková",
  }) });
});

it.each([
  { status: 503, expectedFirstName: undefined },
  { payload: { icoId: "12345678", zaznamy: [{ ico: "12345678", primarniZaznam: true, osobaPodnikatel: { jmeno: "Anna" } }] }, expectedFirstName: "Anna" },
  { payload: { icoId: "87654321", zaznamy: [{ ico: "87654321", primarniZaznam: true, osobaPodnikatel: { jmeno: "Other", prijmeni: "Taxpayer" } }] }, expectedFirstName: undefined },
  { payload: { icoId: "12345678", zaznamy: [{ ico: "12345678", primarniZaznam: false, osobaPodnikatel: { jmeno: "Old", prijmeni: "Record" } }] }, expectedFirstName: undefined },
])("keeps missing natural-person fields editable when the structured registry detail is incomplete or unavailable: %j", async ({ payload, status, expectedFirstName }) => {
  const result = await prefillCompanyFromAres(aresRegistry(async (url) =>
    String(url).includes("ekonomicke-subjekty-rzp/")
      ? Response.json(payload ?? {}, { status: status ?? 200 })
      : Response.json({ ico: "12345678", obchodniJmeno: "Ing. Anna Long Business Name", pravniForma: "101" }),
  ), "12345678");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.personType).toBe("natural");
  expect(result.value.lastName).toBeUndefined();
  expect(result.value.firstName).toBe(expectedFirstName);
});

it("does not prefill a different IČO returned by the provider", async () => {
  expect(await prefillCompanyFromAres(aresRegistry(async () => Response.json({
    ico: "87654321", obchodniJmeno: "Other Company", pravniForma: "112",
  })), "12345678")).toEqual({ ok: false, error: "ares_unavailable" });
});

it("retains a reliable person type when the trading name is unavailable", async () => {
  const result = await prefillCompanyFromAres(aresRegistry(async () => Response.json({
    ico: "27082440", pravniForma: "121",
  })), "27082440");
  expect(result).toEqual({ ok: true, value: expect.objectContaining({
    personType: "legal", name: "", city: "",
  }) });
});

const registry: AresRegistry = {
  async findByIco(ico) {
    if (ico !== "27082440") {
      return { ok: false, error: "ares_company_not_found" };
    }
    return {
      ok: true,
      value: {
        name: "Alza.cz a.s.",
        ico,
        vatId: "CZ27082440",
        streetName: "Jankovcova",
        houseNumber: "1522",
        orientationNumber: "53",
        city: "Praha",
        postalCode: "170 00",
      },
    };
  },
};

it("prefills editable Company details from an injected ARES registry", async () => {
  expect(await prefillCompanyFromAres(registry, " 27082440 ")).toEqual({
    ok: true,
    value: {
      name: "Alza.cz a.s.",
      ico: "27082440",
      vatId: "CZ27082440",
      streetName: "Jankovcova",
      houseNumber: "1522",
      orientationNumber: "53",
      city: "Praha",
      postalCode: "170 00",
    },
  });
});

it("refuses malformed IČO without consulting ARES", async () => {
  expect(await prefillCompanyFromAres(registry, "123")).toEqual({
    ok: false,
    error: "invalid_ico",
  });
});

it("preserves a not-found refusal from the ARES boundary", async () => {
  expect(await prefillCompanyFromAres(registry, "12345678")).toEqual({
    ok: false,
    error: "ares_company_not_found",
  });
});
