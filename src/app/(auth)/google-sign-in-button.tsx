import { getTranslations } from "next-intl/server";
import { googleSignInAction } from "@/app/actions";
import { Button } from "@/components/button";

export async function GoogleSignInButton() {
  const t = await getTranslations("auth");
  return (
    <>
      <div className="auth-divider"><span>{t("or")}</span></div>
      <form action={googleSignInAction}>
        <Button className="auth-google-button" type="submit">
          {t("continueWithGoogle")}
        </Button>
      </form>
    </>
  );
}
