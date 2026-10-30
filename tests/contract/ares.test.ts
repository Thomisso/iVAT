import { expect, it } from "vitest";
import { aresRegistry } from "@/ares/registry";

const contract = process.env.ARES_CONTRACT_TEST === "1" ? it : it.skip;

contract("reads a Czech VAT payer from the live ARES service", async () => {
  const result = await aresRegistry().findByIco("27082440");

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value).toEqual(
    expect.objectContaining({
      ico: "27082440",
      vatId: "CZ27082440",
      name: expect.any(String),
      personType: "legal",
      streetName: expect.any(String),
      houseNumber: expect.any(String),
      orientationNumber: expect.any(String),
      city: expect.any(String),
      postalCode: expect.stringMatching(/^\d{3} \d{2}$/),
    }),
  );
});
