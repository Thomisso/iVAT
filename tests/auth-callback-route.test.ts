import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  verifyEmailOtp: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; value?: null; error?: string }>>(async () => ({ ok: true, value: null })),
  completeGoogleSignIn: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; value?: null; error?: string }>>(),
}));

vi.mock("@/application/auth", () => ({
  completeGoogleSignIn: auth.completeGoogleSignIn,
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
  vi.resetAllMocks();
  auth.verifyEmailOtp.mockResolvedValue({ ok: true, value: null });
});

describe("Auth callback route", () => {
  it("keeps legacy recovery callbacks read-only and redirects their tokens to the trusted landing fragment", async () => {
    process.env.APP_ORIGIN = "https://app.example.test";
    process.env.AUTH_REDIRECT_ALLOWLIST = "https://app.example.test/auth/callback";
    const nextUrl = new URL("http://untrusted.example.test/auth/callback?token_hash=unused&type=recovery&request=proof&next=https://untrusted.example.test");
    const response = await GET({ url: nextUrl.toString(), nextUrl } as NextRequest);
    expect(response.headers.get("location")).toBe("https://app.example.test/password/reset#request=proof&token_hash=unused");
    expect(auth.verifyEmailOtp).not.toHaveBeenCalled();
  });
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

  it.each(["oauth", "email"])("preserves temporary unavailability for a %s callback on the trusted public origin", async kind => {
    process.env.APP_ORIGIN = "https://app.example.test";
    process.env.AUTH_REDIRECT_ALLOWLIST = "https://app.example.test/auth/callback";
    auth.verifyEmailOtp.mockResolvedValueOnce({ ok: false, error: "auth_unavailable" });
    auth.completeGoogleSignIn.mockResolvedValueOnce({ ok: false, error: "auth_unavailable" });
    const nextUrl = new URL(`http://gateway/auth/callback?${kind === "oauth" ? "code=code" : "token_hash=token&type=signup"}`);
    const response = await GET({ url: nextUrl.toString(), nextUrl } as NextRequest);
    expect(response.headers.get("location")).toBe("https://app.example.test/auth/unavailable");
  });

});
