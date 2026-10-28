import { expect, it } from "vitest";
import { adisVatPayerRegistry } from "@/vat-registry/adis";

const contract = process.env.ADIS_CONTRACT_TEST === "1" ? it : it.skip;

contract("checks a Czech VAT payer through the live ADIS service", async () => {
  const result = await adisVatPayerRegistry().check("CZ27082440");

  expect(result.outcome).not.toBe("unavailable");
  if (result.outcome !== "checked") throw new Error(result.outcome);
  expect(result).toEqual({
    outcome: "checked",
    unreliable: expect.any(Boolean),
    publishedAccounts: expect.any(Array),
  });
});
