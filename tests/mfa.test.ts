import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  beginTotpEnrollment,
  completeTotpEnrollment,
  disenrollMfa,
  mfaPolicy,
  mfaStatus,
  setOrganizationMfaRequired,
  verifyRecoveryCode,
  verifyTotp,
} from "@/application/mfa";
import { logIn, logOut } from "@/application/auth";
import { listAuditEvents } from "@/application/audit";
import { listMyCompanies } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { provisionedUser } from "./support/clients";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { systemClient } from "./support/worker";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function totp(secret: string, at = Date.now()): string {
  let bits = "";
  for (const character of secret.replace(/=+$/u, "").toUpperCase()) {
    bits += BASE32.indexOf(character).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(
    bits.match(/.{8}/gu)?.map((byte) => Number.parseInt(byte, 2)) ?? [],
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest.at(-1)! & 0x0f;
  const value =
    (((digest[offset]! & 0x7f) << 24) |
      ((digest[offset + 1]! & 0xff) << 16) |
      ((digest[offset + 2]! & 0xff) << 8) |
      (digest[offset + 3]! & 0xff)) %
    1_000_000;
  return String(value).padStart(6, "0");
}

describe("MFA", () => {
  it("can restart an unfinished TOTP enrollment", async () => {
    const user = await provisionedUser();

    expect((await beginTotpEnrollment(user.client)).ok).toBe(true);
    expect((await beginTotpEnrollment(user.client)).ok).toBe(true);
  });

  it("enrols and verifies a TOTP authenticator, returns ten recovery codes, and audits the change", async () => {
    const user = await provisionedUser();

    const enrollment = await beginTotpEnrollment(user.client);
    expect(enrollment.ok).toBe(true);
    if (!enrollment.ok) return;

    const completed = await completeTotpEnrollment(user.client, {
      factorId: enrollment.value.factorId,
      code: totp(enrollment.value.secret),
    });

    expect(completed).toEqual({
      ok: true,
      value: { recoveryCodes: expect.arrayContaining([expect.any(String)]) },
    });
    if (!completed.ok) return;
    expect(completed.value.recoveryCodes).toHaveLength(10);
    expect(await mfaStatus(user.client)).toEqual(
      expect.objectContaining({ enrolled: true, currentLevel: "aal2" }),
    );
    expect((await listAuditEvents(user.client, user.organizationId)).at(-1)).toEqual(
      expect.objectContaining({
        action: "user.mfa_enrolled",
        targetType: "user",
        targetId: user.userId,
        payload: {},
      }),
    );
  });

  it("accepts each recovery code only once", async () => {
    const user = await provisionedUser();
    const enrollment = await beginTotpEnrollment(user.client);
    if (!enrollment.ok) throw new Error(enrollment.error);
    const completed = await completeTotpEnrollment(user.client, {
      factorId: enrollment.value.factorId,
      code: totp(enrollment.value.secret),
    });
    if (!completed.ok) throw new Error(completed.error);
    const [recoveryCode] = completed.value.recoveryCodes;

    await logOut(user.client);
    await logIn(user.client, {
      email: user.email,
      password: "correct-horse-battery",
    });
    expect(await verifyRecoveryCode(user.client, recoveryCode!)).toEqual({
      ok: true,
      value: null,
    });

    await logOut(user.client);
    await logIn(user.client, {
      email: user.email,
      password: "correct-horse-battery",
    });
    expect(await verifyRecoveryCode(user.client, recoveryCode!)).toEqual({
      ok: false,
      error: "invalid_mfa_code",
    });
  });

  it("verifies TOTP after login and lets the user disenrol with an audit event", async () => {
    const user = await provisionedUser();
    const enrollment = await beginTotpEnrollment(user.client);
    if (!enrollment.ok) throw new Error(enrollment.error);
    const completed = await completeTotpEnrollment(user.client, {
      factorId: enrollment.value.factorId,
      code: totp(enrollment.value.secret),
    });
    if (!completed.ok) throw new Error(completed.error);

    await logOut(user.client);
    await logIn(user.client, {
      email: user.email,
      password: "correct-horse-battery",
    });
    expect(await mfaStatus(user.client)).toEqual(
      expect.objectContaining({ currentLevel: "aal1", nextLevel: "aal2" }),
    );
    expect(await listMyOrganizations(user.client)).toEqual([]);
    expect(
      await verifyTotp(user.client, {
        factorId: enrollment.value.factorId,
        code: totp(enrollment.value.secret),
      }),
    ).toEqual({ ok: true, value: null });
    expect(await listMyOrganizations(user.client)).toEqual([
      expect.objectContaining({ id: user.organizationId }),
    ]);

    expect(await disenrollMfa(user.client, enrollment.value.factorId)).toEqual({
      ok: true,
      value: null,
    });
    expect(await mfaStatus(user.client)).toEqual(
      expect.objectContaining({ enrolled: false, recoveryCodesRemaining: 0 }),
    );
    expect((await listAuditEvents(user.client, user.organizationId)).at(-1)).toEqual(
      expect.objectContaining({
        action: "user.mfa_disenrolled",
        targetType: "user",
        targetId: user.userId,
        payload: {},
      }),
    );
  });

  it("lets an Organization Administrator require MFA and blocks a non-enrolled member from Organization data", async () => {
    const administrator = await administratorWithCompany();
    const member = await companyMember(administrator);

    expect(
      await setOrganizationMfaRequired(administrator.client, {
        organizationId: administrator.organizationId,
        required: true,
      }),
    ).toEqual({ ok: true, value: null });
    expect(await listMyCompanies(member.client)).toEqual([]);

    const enrollment = await beginTotpEnrollment(member.client);
    if (!enrollment.ok) throw new Error(enrollment.error);
    const completed = await completeTotpEnrollment(member.client, {
      factorId: enrollment.value.factorId,
      code: totp(enrollment.value.secret),
    });
    if (!completed.ok) throw new Error(completed.error);
    expect(await listMyCompanies(member.client)).toEqual([
      expect.objectContaining({ id: administrator.companyId }),
    ]);

    const adminEnrollment = await beginTotpEnrollment(administrator.client);
    if (!adminEnrollment.ok) throw new Error(adminEnrollment.error);
    const adminCompleted = await completeTotpEnrollment(administrator.client, {
      factorId: adminEnrollment.value.factorId,
      code: totp(adminEnrollment.value.secret),
    });
    if (!adminCompleted.ok) throw new Error(adminCompleted.error);
    expect(
      (await listAuditEvents(administrator.client, administrator.organizationId)).map(
        (event) => event.action,
      ),
    ).toContain("organization.mfa_enforcement_changed");
  });

  it("refuses a Company User who tries to change Organization MFA enforcement", async () => {
    const administrator = await administratorWithCompany();
    const member = await companyMember(administrator);

    expect(
      await setOrganizationMfaRequired(member.client, {
        organizationId: administrator.organizationId,
        required: true,
      }),
    ).toEqual({ ok: false, error: "forbidden" });
  });

  it("requires MFA for a SuperAdmin before any platform data is accessible", async () => {
    const superAdmin = await administratorWithCompany();
    const promoted = await systemClient().from("platform_user").insert({
      user_id: superAdmin.userId,
      role: "super_admin",
    });
    if (promoted.error) throw promoted.error;

    expect(await mfaPolicy(superAdmin.client)).toEqual({
      required: true,
      enrolled: false,
      satisfied: false,
    });
    expect(await listMyCompanies(superAdmin.client)).toEqual([]);

    const enrollment = await beginTotpEnrollment(superAdmin.client);
    if (!enrollment.ok) throw new Error(enrollment.error);
    const completed = await completeTotpEnrollment(superAdmin.client, {
      factorId: enrollment.value.factorId,
      code: totp(enrollment.value.secret),
    });
    if (!completed.ok) throw new Error(completed.error);

    expect(await mfaPolicy(superAdmin.client)).toEqual({
      required: true,
      enrolled: true,
      satisfied: true,
    });
    expect(await listMyCompanies(superAdmin.client)).toContainEqual(
      expect.objectContaining({ id: superAdmin.companyId }),
    );
  });
});
