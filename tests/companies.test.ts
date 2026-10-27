import { describe, expect, it } from "vitest";
import { createCompany, getCompany, listMyCompanies } from "@/application/companies";
import { signedUpUser } from "./support/clients";
import { administratorWithCompany, companyDetails } from "./support/fixtures";

const novak = {
  name: "Novák s.r.o.",
  ico: "27082440",
  vatId: "CZ27082440",
  street: "Vinohradská 12",
  city: "Praha",
  postalCode: "120 00",
};

describe("Company creation", () => {
  it("lets the Organization Administrator create a Company and open it", async () => {
    const { client, organizationId } = await signedUpUser();

    const result = await createCompany(client, { organizationId, ...novak });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await getCompany(client, result.value.id)).toEqual({
      id: result.value.id,
      organizationId,
      ...novak,
      aiProcessing: null,
    });
    expect(await listMyCompanies(client)).toEqual([
      { id: result.value.id, organizationId, name: "Novák s.r.o." },
    ]);
  });
});

describe("Company details", () => {
  it("are normalized before saving", async () => {
    const { client, organizationId } = await signedUpUser();

    const result = await createCompany(client, {
      organizationId,
      name: "  Novák s.r.o. ",
      ico: " 27082440 ",
      vatId: "cz 27082440",
      street: " Vinohradská 12 ",
      city: " Praha ",
      postalCode: "12000",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await getCompany(client, result.value.id)).toEqual(
      expect.objectContaining({ name: "Novák s.r.o.", ico: "27082440", vatId: "CZ27082440", postalCode: "120 00" }),
    );
  });

  it.each([
    [{ name: " " }, "name_required"],
    [{ ico: "1234567" }, "invalid_ico"],
    [{ vatId: "SK2708244012" }, "invalid_vat_id"],
    [{ street: "" }, "address_required"],
    [{ city: "" }, "address_required"],
    [{ postalCode: "1200" }, "invalid_postal_code"],
  ])("are refused when invalid: %o", async (override, error) => {
    const { client, organizationId } = await signedUpUser();

    const result = await createCompany(client, { organizationId, ...companyDetails(override) });

    expect(result).toEqual({ ok: false, error });
    expect(await listMyCompanies(client)).toEqual([]);
  });

  it("are refused when the IČO is already used in the Organization", async () => {
    const { client, organizationId, companyId } = await administratorWithCompany();
    const existing = await getCompany(client, companyId);

    const result = await createCompany(client, { organizationId, ...companyDetails({ ico: existing!.ico }) });

    expect(result).toEqual({ ok: false, error: "ico_taken" });
  });
});

it("opening a Company that does not exist finds nothing", async () => {
  const { client } = await signedUpUser();

  expect(await getCompany(client, "00000000-0000-0000-0000-000000000000")).toBeNull();
  expect(await getCompany(client, "not-a-uuid")).toBeNull();
});
