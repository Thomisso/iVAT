import { getTranslations } from "next-intl/server";
import { AcceptInvitationForm } from "./accept-invitation-form";

export default async function AcceptInvitationPage({ searchParams }: PageProps<"/invitations/accept">) {
  const token = String((await searchParams).token ?? "");
  const t = await getTranslations("members");
  return (
    <main className="auth-shell">
      <section className="panel auth-card">
        <h1>{t("acceptTitle")}</h1>
        <p>{t("acceptIntro")}</p>
        <AcceptInvitationForm token={token} />
      </section>
    </main>
  );
}
