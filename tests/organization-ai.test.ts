import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, inject, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import { asUserClient } from "@/application/client";
import {
  listOrganizationAiProviderKeys,
  removeOrganizationAiProviderKey,
  saveOrganizationAiProviderKey,
} from "@/application/organization-ai";
import {
  configurePlatformAiProvider,
  resolvePlatformAiProvider,
  setOrganizationPlatformAiAccess,
} from "@/application/platform-ai";
import { signedUpUser } from "./support/clients";
import { administratorWithCompany } from "./support/fixtures";
import { systemClient } from "./support/worker";

function aal2Client(userId: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    aud: "authenticated",
    exp: now + 3600,
    iat: now,
    sub: userId,
    role: "authenticated",
    aal: "aal2",
    session_id: `organization-key-test-${userId}`,
  })}`;
  const signature = createHmac("sha256", inject("supabaseJwtSecret"))
    .update(unsigned)
    .digest("base64url");
  return asUserClient(
    createClient(inject("supabaseUrl"), inject("supabaseAnonKey"), {
      accessToken: async () => `${unsigned}.${signature}`,
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  );
}

describe("Organization AI provider keys", () => {
  it("requires the DPA acknowledgement and returns only the stored key's last four characters", async () => {
    const administrator = await administratorWithCompany("BYOK Organization");

    expect(
      await saveOrganizationAiProviderKey(administrator.client, {
        organizationId: administrator.organizationId,
        provider: "anthropic",
        apiKey: "sk-ant-organization-secret",
        dpaAcknowledged: false,
      }),
    ).toEqual({ ok: false, error: "dpa_acknowledgement_required" });

    expect(
      await saveOrganizationAiProviderKey(administrator.client, {
        organizationId: administrator.organizationId,
        provider: "anthropic",
        apiKey: "sk-ant-organization-secret",
        dpaAcknowledged: true,
      }),
    ).toEqual({ ok: true, value: null });
    expect(
      await listOrganizationAiProviderKeys(administrator.client, administrator.organizationId),
    ).toEqual({
      ok: true,
      value: [{ provider: "anthropic", hasOrganizationKey: true, organizationKeyLastFour: "cret" }],
    });

    const events = await listAuditEvents(administrator.client, administrator.organizationId);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        action: "organization_ai_key.saved",
        organizationId: administrator.organizationId,
        companyId: null,
        targetType: "organization_ai_key",
        payload: { provider: "anthropic", dpa_acknowledged: true },
      }),
    );
    expect(JSON.stringify(events.at(-1))).not.toContain("sk-ant-organization-secret");
  });

  it("resolves, replaces and removes an Organization key before falling back to the platform key", async () => {
    const administrator = await signedUpUser("BYOK precedence");
    const promoted = await systemClient().from("platform_user").insert({
      user_id: administrator.userId,
      role: "super_admin",
    });
    if (promoted.error) throw promoted.error;
    const client = aal2Client(administrator.userId);

    expect(
      await configurePlatformAiProvider(client, {
        provider: "anthropic",
        available: true,
        splitModel: "claude-split",
        extractModel: "claude-extract",
        apiKey: "sk-ant-platform-key",
      }),
    ).toEqual({ ok: true, value: null });
    expect(
      await setOrganizationPlatformAiAccess(client, {
        organizationId: administrator.organizationId,
        provider: "anthropic",
        enabled: true,
      }),
    ).toEqual({ ok: true, value: null });

    expect(
      await resolvePlatformAiProvider(systemClient(), administrator.organizationId, "anthropic"),
    ).toEqual({
      ok: true,
      value: {
        apiKey: "sk-ant-platform-key",
        splitModel: "claude-split",
        extractModel: "claude-extract",
      },
    });
    expect(
      await saveOrganizationAiProviderKey(client, {
        organizationId: administrator.organizationId,
        provider: "anthropic",
        apiKey: "sk-ant-first-organization-key",
        dpaAcknowledged: true,
      }),
    ).toEqual({ ok: true, value: null });
    expect(
      await resolvePlatformAiProvider(systemClient(), administrator.organizationId, "anthropic"),
    ).toEqual({
      ok: true,
      value: {
        apiKey: "sk-ant-first-organization-key",
        splitModel: "claude-split",
        extractModel: "claude-extract",
      },
    });

    expect(
      await saveOrganizationAiProviderKey(client, {
        organizationId: administrator.organizationId,
        provider: "anthropic",
        apiKey: "sk-ant-replaced-organization-key",
        dpaAcknowledged: true,
      }),
    ).toEqual({ ok: true, value: null });
    expect(
      await resolvePlatformAiProvider(systemClient(), administrator.organizationId, "anthropic"),
    ).toEqual({
      ok: true,
      value: {
        apiKey: "sk-ant-replaced-organization-key",
        splitModel: "claude-split",
        extractModel: "claude-extract",
      },
    });

    expect(
      await removeOrganizationAiProviderKey(client, {
        organizationId: administrator.organizationId,
        provider: "anthropic",
      }),
    ).toEqual({ ok: true, value: null });
    expect(
      await resolvePlatformAiProvider(systemClient(), administrator.organizationId, "anthropic"),
    ).toEqual({
      ok: true,
      value: {
        apiKey: "sk-ant-platform-key",
        splitModel: "claude-split",
        extractModel: "claude-extract",
      },
    });

    const events = await listAuditEvents(client, administrator.organizationId);
    expect(events.slice(-3).map((event) => event.action)).toEqual([
      "organization_ai_key.saved",
      "organization_ai_key.saved",
      "organization_ai_key.removed",
    ]);
    expect(JSON.stringify(events)).not.toContain("sk-ant-replaced-organization-key");
  });

  it("refuses non-Organization Administrators and exposes no direct table access", async () => {
    const target = await administratorWithCompany("Protected BYOK Organization");
    const outsider = await signedUpUser("Another Organization");

    expect(
      await saveOrganizationAiProviderKey(outsider.client, {
        organizationId: target.organizationId,
        provider: "anthropic",
        apiKey: "sk-ant-forbidden-key",
        dpaAcknowledged: true,
      }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(await listOrganizationAiProviderKeys(outsider.client, target.organizationId)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(
      await removeOrganizationAiProviderKey(outsider.client, {
        organizationId: target.organizationId,
        provider: "anthropic",
      }),
    ).toEqual({ ok: false, error: "forbidden" });

    const direct = await target.client.from("organization_ai_provider_key").select("*");
    expect(direct.error?.code).toBe("42501");
  });
});
