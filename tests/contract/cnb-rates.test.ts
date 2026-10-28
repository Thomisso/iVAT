import { expect, it } from "vitest";
import { cnbExchangeRates } from "@/cnb/rates";

const contract = process.env.CNB_CONTRACT_TEST === "1" ? it : it.skip;

contract("reads a dated EUR fixing from the live ČNB API", async () => {
  const result = await cnbExchangeRates().rateFor("2026-10-27", "EUR");

  expect(result).toEqual({
    currency: "EUR",
    requestedDate: "2026-10-27",
    rateDate: "2026-10-27",
    unit: 1,
    rate: expect.any(String),
    source: "CNB",
  });
});
