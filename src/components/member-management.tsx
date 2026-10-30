"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { changeMembershipRoleAction, inviteMemberAction, removeMembershipAction } from "@/app/actions";
import type { CompanyAccess, Membership, PendingInvitation } from "@/application/memberships";
import { Button } from "./button";
import { FormError } from "./form-error";
import { TextField } from "./text-field";
import { formatDateTime } from "@/lib/format-date";

type ActiveAccess = {
  email: string;
  role: "administrator" | "user";
  source: CompanyAccess["source"] | null;
  manageableMembershipId: string | null;
};

function AccessRow({ access, organizationScope }: { access: ActiveAccess; organizationScope: boolean }) {
  const t = useTranslations("members");
  const [roleState, roleAction, rolePending] = useActionState(changeMembershipRoleAction, { error: null, values: {} });
  const [removeState, removeAction, removePending] = useActionState(removeMembershipAction, { error: null, values: {} });
  return (
    <li className="panel member-access-row">
      <div className="member-access-identity">
        <strong>{access.email}</strong>
        <span>{t(access.role === "administrator" ? "administrator" : "user")}</span>
        {access.source && <span className="member-access-source">{t(`source.${access.source}`)}</span>}
      </div>
      {access.manageableMembershipId && !organizationScope && <form action={roleAction} className="form-row">
        <input type="hidden" name="membershipId" value={access.manageableMembershipId} />
        <label className="iv-field-label">
          {t("role")}
          <select name="role" defaultValue={roleState.values.role ?? access.role}>
            <option value="administrator">{t("administrator")}</option>
            <option value="user">{t("user")}</option>
          </select>
        </label>
        <Button type="submit" disabled={rolePending}>{t("changeRole")}</Button>
      </form>}
      <FormError error={roleState.error} />
      {access.manageableMembershipId && <form action={removeAction}>
        <input type="hidden" name="membershipId" value={access.manageableMembershipId} />
        <Button type="submit" variant="danger" disabled={removePending}>{t("remove")}</Button>
      </form>}
      <FormError error={removeState.error} />
    </li>
  );
}

export function MemberManagement({
  organizationId,
  companyId,
  memberships,
  companyAccess,
  pendingInvitations,
}: {
  organizationId: string;
  companyId: string | null;
  memberships?: Membership[];
  companyAccess?: CompanyAccess[];
  pendingInvitations: PendingInvitation[];
}) {
  const t = useTranslations("members");
  const [state, action, pending] = useActionState(inviteMemberAction, { error: null, values: {} });
  const activeAccess: ActiveAccess[] = companyAccess ?? (memberships ?? []).map((membership) => ({
    email: membership.email,
    role: membership.role,
    source: null,
    manageableMembershipId: membership.id,
  }));
  return (
    <div className="member-management">
      <section className="panel">
        <h2>{t("inviteTitle")}</h2>
        <form action={action} className="form settings-form">
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="companyId" value={companyId ?? ""} />
          <TextField label={t("email")} name="email" type="email" defaultValue={state.values.email} required />
          <label className="iv-field-label">
            {t("role")}
            <select name="role" defaultValue={companyId === null ? "administrator" : (state.values.role ?? "user")}>
              <option value="administrator">{t("administrator")}</option>
              {companyId !== null && <option value="user">{t("user")}</option>}
            </select>
          </label>
          <FormError error={state.error} />
          <Button type="submit" variant="primary" disabled={pending}>{t("invite")}</Button>
        </form>
      </section>
      <section>
        <h2>{t("activeTitle")}</h2>
        <p>{t("activeIntro")}</p>
        {activeAccess.length === 0 ? <p>{t("none")}</p> : (
          <ul className="member-list">{activeAccess.map((access) => <AccessRow
            access={access}
            key={`${access.email}:${access.source ?? "organization"}`}
            organizationScope={companyId === null}
          />)}</ul>
        )}
      </section>
      <section>
        <h2>{t("pendingTitle")}</h2>
        {pendingInvitations.length === 0 ? <p>{t("pendingNone")}</p> : <ul className="member-list">
          {pendingInvitations.map((invitation) => <li className="panel member-invitation-row" key={invitation.id}>
            <strong>{invitation.email}</strong>
            <span>{t(invitation.role === "administrator" ? "administrator" : "user")}</span>
            <span>{t(`invitationStatus.${invitation.status}`)}</span>
            <span>{t("expires", {
              date: formatDateTime(invitation.expiresAt),
            })}</span>
          </li>)}
        </ul>}
      </section>
    </div>
  );
}
