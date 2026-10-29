import Link from "next/link";
import { useTranslations } from "next-intl";
import type { OrganizationSummary } from "@/application/organizations";

type AdministrationLink = { href: string; label: string };
type AdministrationGroup = { key: string; label: string; links: AdministrationLink[] };

export function AdministrationNavigation({ className, companyId, companyRole, currentPath, organizations, superAdmin }: {
  className?: string;
  companyId: string;
  companyRole: "administrator" | "user" | null;
  currentPath?: string;
  organizations: OrganizationSummary[];
  superAdmin: boolean;
}) {
  const t = useTranslations("shell");
  const groups: AdministrationGroup[] = [
    ...(companyRole === "administrator" ? [{
      key: "company",
      label: t("companyAdministration"),
      links: [{ href: `/companies/${companyId}/settings/users`, label: t("users") }],
    }] : []),
    ...organizations.filter((organization) => organization.role === "administrator").map((organization) => ({
      key: organization.id,
      label: organization.name,
      links: [
        { href: `/organizations/${organization.id}/members`, label: t("users") },
        { href: `/organizations/${organization.id}/audit-log`, label: t("auditLog") },
      ],
    })),
    ...(superAdmin ? [{
      key: "platform",
      label: t("platformAdministration"),
      links: [
        { href: "/platform/administration", label: t("platformOverview") },
        { href: "/platform/ai-settings", label: t("platformAi") },
        { href: "/platform/ai-usage", label: t("platformUsage") },
      ],
    }] : []),
  ];
  if (!groups.length) return null;

  return <nav aria-label={t("administration")} className={["administration-navigation", className].filter(Boolean).join(" ")}>
    <p aria-hidden="true" className="administration-navigation-title">{t("administration")}</p>
    {groups.map((group) => <div aria-label={group.label} className="administration-navigation-group" key={group.key} role="group">
      <p aria-hidden="true">{group.label}</p>
      <ul>
        {group.links.map((link) => <li key={link.href}>
          <Link aria-current={link.href === currentPath ? "page" : undefined} href={link.href}>{link.label}</Link>
        </li>)}
      </ul>
    </div>)}
  </nav>;
}
