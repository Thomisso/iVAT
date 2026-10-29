import { getTranslations } from "next-intl/server";
import { getInvitationOnboarding } from "@/application/memberships";
import { FocusedShell } from "@/components/focused-shell";
import { FormError } from "@/components/form-error";
import { createRequestClient } from "@/lib/supabase/server";
import { AcceptInvitationForm } from "./accept-invitation-form";

export default async function AcceptInvitationPage({ searchParams }: PageProps<"/invitations/accept">) {
  const token = String((await searchParams).token ?? "");
  const onboarding = await getInvitationOnboarding(await createRequestClient(), token);
  const t = await getTranslations("members");
  return (
    <FocusedShell>
      <main className="focused-shell-card" id="main-content" tabIndex={-1}>
        {onboarding.status === "valid" ? (
          <>
            <h1>{t(onboarding.existingUser ? "logInToAcceptTitle" : "setPasswordTitle")}</h1>
            <p>{t(onboarding.existingUser ? "existingUserIntro" : "newUserIntro")}</p>
            <AcceptInvitationForm
              token={token}
              email={onboarding.email}
              existingUser={onboarding.existingUser}
            />
          </>
        ) : (
          <>
            <h1>{t("acceptTitle")}</h1>
            <FormError error={`invitation_${onboarding.status}`} />
          </>
        )}
      </main>
    </FocusedShell>
  );
}
