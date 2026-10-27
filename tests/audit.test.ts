import { describe, expect, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import { signedUpUser } from "./support/clients";
import { administratorWithCompany } from "./support/fixtures";

describe("audit log", () => {
  it("records the sign-up", async () => {
    const { client, userId, email, organizationId } = await signedUpUser("Novák s.r.o.");

    expect(await listAuditEvents(client, organizationId)).toEqual([
      expect.objectContaining({
        action: "user.signed_up",
        actorUserId: userId,
        organizationId,
        companyId: null,
        targetType: "user",
        targetId: userId,
        payload: { email, organization_name: "Novák s.r.o." },
      }),
    ]);
  });

  it("records Company creation", async () => {
    const { client, userId, organizationId, companyId } = await administratorWithCompany();

    const events = await listAuditEvents(client, organizationId);

    expect(events.map((e) => e.action)).toEqual(["user.signed_up", "company.created"]);
    expect(events[1]).toEqual(
      expect.objectContaining({
        actorUserId: userId,
        organizationId,
        companyId,
        targetType: "company",
        targetId: companyId,
        payload: expect.objectContaining({ name: "Novák s.r.o." }),
      }),
    );
  });

  it("cannot be written, changed or deleted by users, even through direct queries", async () => {
    const { client, userId, organizationId } = await administratorWithCompany();
    const before = await listAuditEvents(client, organizationId);

    const insert = await client.from("audit_event").insert({
      organization_id: organizationId,
      actor_user_id: userId,
      action: "company.created",
      target_type: "company",
    });
    const update = await client.from("audit_event").update({ action: "tampered" }).eq("organization_id", organizationId);
    const remove = await client.from("audit_event").delete().eq("organization_id", organizationId);

    for (const attempt of [insert, update, remove]) {
      expect(attempt.error?.code).toBe("42501");
    }
    expect(await listAuditEvents(client, organizationId)).toEqual(before);
  });

  it("is not readable by another Organization", async () => {
    const a = await administratorWithCompany("Organization A");
    const b = await signedUpUser("Organization B");

    expect(await listAuditEvents(b.client, a.organizationId)).toEqual([]);
  });
});
