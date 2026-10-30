import { FocusedShell } from "@/components/focused-shell";
import { InvitationLanding } from "./invitation-landing";

export const metadata = { referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function AcceptInvitationPage({ searchParams }: PageProps<"/invitations/accept">) {
  const legacyToken = String((await searchParams).token ?? "");
  return <FocusedShell>
    <main className="focused-shell-card" id="main-content" tabIndex={-1}>
      <InvitationLanding legacyToken={legacyToken} />
    </main>
  </FocusedShell>;
}
