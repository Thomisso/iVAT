import { describe, expect, it } from "vitest";
import { listMyOrganizations } from "@/application/organizations";
import { signedUpUser } from "./support/clients";

describe("sign-up", () => {
  it("creates an Organization and makes the user its Administrator", async () => {
    const { client } = await signedUpUser("Novák s.r.o.");

    const organizations = await listMyOrganizations(client);

    expect(organizations).toEqual([
      { id: expect.any(String), name: "Novák s.r.o.", role: "administrator" },
    ]);
  });
});
