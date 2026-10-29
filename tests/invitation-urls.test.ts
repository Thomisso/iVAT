import { describe, expect, it } from "vitest";
import { invitationUrls } from "@/application/invitation-urls";

describe("Invitation URLs", () => {
  it("builds the acceptance and callback URLs from an exactly allowlisted canonical origin", () => {
    expect(invitationUrls({
      appOrigin: "https://app.example.test",
      authRedirectAllowlist: "https://app.example.test/auth/callback",
    })).toEqual({
      ok: true,
      value: {
        acceptUrl: "https://app.example.test/invitations/accept",
        callbackUrl: "https://app.example.test/auth/callback",
      },
    });
  });

  it("refuses malformed and non-allowlisted callback configuration", () => {
    expect(invitationUrls({
      appOrigin: "not a URL",
      authRedirectAllowlist: "https://app.example.test/auth/callback",
    })).toEqual({ ok: false, error: "invitation_failed" });
    expect(invitationUrls({
      appOrigin: "https://app.example.test",
      authRedirectAllowlist: "https://other.example.test/auth/callback",
    })).toEqual({ ok: false, error: "invitation_failed" });
    expect(invitationUrls({
      appOrigin: "https://app.example.test",
      authRedirectAllowlist: "not a URL",
    })).toEqual({ ok: false, error: "invitation_failed" });
  });
});
