import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  changeMembershipRole: vi.fn(),
  requireUserClient: vi.fn(),
}));

vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createRequestClient: vi.fn(),
  requireUserClient: mocks.requireUserClient,
}));
vi.mock("@/application/memberships", () => ({
  acceptInvitation: vi.fn(),
  changeMembershipRole: mocks.changeMembershipRole,
  inviteMember: vi.fn(),
  removeMembership: vi.fn(),
}));

import { changeMembershipRoleAction } from "@/app/actions";

beforeEach(() => {
  mocks.requireUserClient.mockReset().mockResolvedValue({});
  mocks.changeMembershipRole.mockReset();
});

it("preserves the submitted Role when a Membership Role change is refused", async () => {
  mocks.changeMembershipRole.mockResolvedValue({ ok: false, error: "forbidden" });
  const formData = new FormData();
  formData.set("membershipId", "00000000-0000-4000-8000-000000000001");
  formData.set("role", "administrator");

  await expect(changeMembershipRoleAction({ error: null, values: {} }, formData)).resolves.toEqual({
    error: "forbidden",
    values: { role: "administrator" },
  });
});
