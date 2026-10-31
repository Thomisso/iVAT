import { expect, it } from "vitest";
import { requestPasswordRecovery } from "@/application/password-recovery";
import { anonymousClient, provisionedUser } from "./support/clients";
import { passwordRecoveryAuthenticationFixture, recoveryEmailFixture } from "./support/password-recovery";
import { nativeAuthTemplateFixture, startOwningStackAgainFixture } from "./support/auth-templates";

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
