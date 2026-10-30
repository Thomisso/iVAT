import Link from "next/link";
import { useTranslations } from "next-intl";
import { ShellIcon } from "./shell-controls";

/** Changes work context without changing the authenticated User or their scope. */
export function WorkSectionSwitch({ section, companyHref }: { section: "company" | "platform"; companyHref: string }) {
  const t = useTranslations("shell");
  return <Link
    aria-label={section === "company" ? t("switchToSuperAdmin") : t("returnToCompany")}
    className="organization-company-return"
    href={section === "company" ? "/platform/administration" : companyHref}
  >
    <ShellIcon path={section === "company" ? "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" : "m15 18-6-6 6-6"} />
    <span>{section === "company" ? t("superAdmin") : t("companyWork")}</span>
  </Link>;
}
