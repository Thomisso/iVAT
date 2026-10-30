import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  verifyEmailOtp: vi.fn(async () => ({ ok: true as const, value: null })),
}));

vi.mock("@/application/auth", () => ({
  completeGoogleSignIn: vi.fn(),
  verifyEmailOtp: auth.verifyEmailOtp,
  verifyInvitationEmailOtp: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createRequestClient: vi.fn(async () => ({})),
}));

import { GET } from "@/app/auth/callback/route";

const originalAppOrigin = process.env.APP_ORIGIN;
const originalAllowlist = process.env.AUTH_REDIRECT_ALLOWLIST;

afterEach(() => {
  if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = originalAppOrigin;
  if (originalAllowlist === undefined) delete process.env.AUTH_REDIRECT_ALLOWLIST;
  else process.env.AUTH_REDIRECT_ALLOWLIST = originalAllowlist;
  vi.clearAllMocks();
});

describe("Auth callback route", () => {
  it("redirects to the configured public origin when the request host is internal", async () => {
    process.env.APP_ORIGIN = "https://app.example.test";
    process.env.AUTH_REDIRECT_ALLOWLIST = "https://app.example.test/auth/callback";
    const nextUrl = new URL(
      "http://127.0.0.1:3100/auth/callback?token_hash=token&type=signup&next=%2Fcompanies",
    );

    const response = await GET({ url: nextUrl.toString(), nextUrl } as NextRequest);

    expect(auth.verifyEmailOtp).toHaveBeenCalledWith({}, "token", "signup");
    expect(response.headers.get("location")).toBe("https://app.example.test/companies");
  });
  it("does not consume a legacy invitation Auth token on a scanner GET", async () => {
    process.env.APP_ORIGIN = "https://app.example.test";
    process.env.AUTH_REDIRECT_ALLOWLIST = "https://app.example.test/auth/callback";
    const nextUrl = new URL("http://127.0.0.1:3103/auth/callback?token_hash=unused&type=magiclink&next=%2Finvitations%2Faccept%3Ftoken%3Dcapability");
    const response = await GET({ url: nextUrl.toString(), nextUrl } as NextRequest);
    expect(response.headers.get("location")).toBe("https://app.example.test/invitations/accept?token=capability");
    expect(auth.verifyEmailOtp).not.toHaveBeenCalled();
  });

  it("refuses callback configuration with an untrusted origin", async () => {
    delete process.env.APP_ORIGIN;
    const nextUrl = new URL("https://untrusted.example.test/auth/callback?token_hash=unused&type=magiclink");
    const response = await GET({ url: nextUrl.toString(), nextUrl } as NextRequest);
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(auth.verifyEmailOtp).not.toHaveBeenCalled();
  });

});
