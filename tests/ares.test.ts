import { expect, it } from "vitest";
import {
  prefillCompanyFromAres,
  type AresRegistry,
} from "@/application/ares";

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
        street: "Jankovcova 1522/53",
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
      street: "Jankovcova 1522/53",
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
