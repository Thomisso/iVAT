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

afterEach(() => {
  if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = originalAppOrigin;
  vi.clearAllMocks();
});

describe("Auth callback route", () => {
  it("redirects to the configured public origin when the request host is internal", async () => {
    process.env.APP_ORIGIN = "https://app.example.test";
    const nextUrl = new URL(
      "http://127.0.0.1:3100/auth/callback?token_hash=token&type=signup&next=%2Fcompanies",
    );

    const response = await GET({ url: nextUrl.toString(), nextUrl } as NextRequest);

    expect(auth.verifyEmailOtp).toHaveBeenCalledWith({}, "token", "signup");
    expect(response.headers.get("location")).toBe("https://app.example.test/companies");
  });
});
