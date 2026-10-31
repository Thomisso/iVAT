import { expect, inject, it } from "vitest";
import { requestPasswordRecovery } from "@/application/password-recovery";
import { anonymousClient, provisionedUser } from "./support/clients";
import { passwordRecoveryAuthenticationFixture, recoveryEmailFixture } from "./support/password-recovery";
import { nativeAuthTemplateFixture, startOwningStackAgainFixture } from "./support/auth-templates";
import { capturedNativeEmail } from "./support/recovery-mail";

it("native magic-link delivery includes Czech and English copy while retaining a single-use Auth session", async () => {
  const user = await provisionedUser();
  const requester = anonymousClient();
  const sent = await requester.auth.signInWithOtp({ email: user.email, options: {
    shouldCreateUser: false, emailRedirectTo: "http://127.0.0.1:3103/auth/callback?next=%2F",
  } });
  expect(sent.error).toBeNull();
  const mailpit = new URL(inject("supabaseUrl")); mailpit.port = String(Number(mailpit.port) + 3);
  const email = await capturedNativeEmail(mailpit, user.email);
  expect(email.subject).toBe("Přihlášení do iVAT / Your iVAT sign-in link");
  expect(email.html.includes("Přihlásit se do iVAT")).toBe(true);
  expect(email.html.includes("Sign in to iVAT")).toBe(true);
  expect(email.html.includes("jednu hodinu")).toBe(true);
  expect(email.html.includes("one hour")).toBe(true);
  const links = [...email.html.matchAll(/href="([^"]+)"/g)].map(match => match[1].replaceAll("&amp;", "&"));
  expect(new Set(links).size).toBe(1);
  const link = new URL(links[0]);
  expect(link.origin).toBe("http://127.0.0.1:3103");
  expect(link.pathname).toBe("/auth/callback");
  expect(link.searchParams.get("type")).toBe("magiclink");
  const tokenHash = link.searchParams.get("token_hash")!;
  const visitor = anonymousClient();
  expect((await visitor.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" })).error).toBeNull();
  expect((await visitor.auth.getUser()).data.user?.id).toBe(user.userId);
  expect((await anonymousClient().auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" })).error?.code).toBe("otp_expired");
});

it("repeated startup preserves live Auth templates and native recovery links without ending existing sessions", async () => {
  const before = { recovery: nativeAuthTemplateFixture("recovery"), magic: nativeAuthTemplateFixture("magic_link") };
  expect(before.recovery.ok).toBe(true);
  expect(before.magic.ok).toBe(true);
  const first = await provisionedUser();
  const authentication = passwordRecoveryAuthenticationFixture();
  expect((await requestPasswordRecovery(anonymousClient(), authentication, first.email)).ok).toBe(true);
  expect((await recoveryEmailFixture(first.email)).url.pathname).toBe("/password/reset");

  startOwningStackAgainFixture();
  const after = { recovery: nativeAuthTemplateFixture("recovery"), magic: nativeAuthTemplateFixture("magic_link") };
  const second = await provisionedUser();
  expect((await requestPasswordRecovery(anonymousClient(), authentication, second.email)).ok).toBe(true);
  // Check native delivery as well as HTTP; fallback templates must never count as success.
  let recoveryPath: string | null = null;
  try { recoveryPath = (await recoveryEmailFixture(second.email)).url.pathname; }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "Native recovery email lacks its application link") throw error;
  }
  expect({ recoveryHttp: after.recovery.ok, magicHttp: after.magic.ok, recoveryPath })
    .toEqual({ recoveryHttp: true, magicHttp: true, recoveryPath: "/password/reset" });
  expect(after).toEqual(before);
  expect((await first.client.auth.getUser()).data.user?.id).toBe(first.userId);
});
