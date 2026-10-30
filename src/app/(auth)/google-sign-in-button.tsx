import { getTranslations } from "next-intl/server";
import { googleSignInAction } from "@/app/actions";
import { Button } from "@/components/button";
import { googleSignInAvailable } from "@/application/auth";
import { createRequestClient } from "@/lib/supabase/server";
import { supabasePublishableKey, supabaseUrl } from "@/lib/env";

export async function GoogleSignInButton() {
  if (!(await googleSignInAvailable(await createRequestClient(), { supabaseUrl, publishableKey: supabasePublishableKey }))) return null;
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
