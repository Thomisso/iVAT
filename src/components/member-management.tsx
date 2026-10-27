"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { changeMembershipRoleAction, inviteMemberAction, removeMembershipAction } from "@/app/actions";
import type { Membership } from "@/application/memberships";
import { Button } from "./button";
import { FormError } from "./form-error";
import { TextField } from "./text-field";

function MembershipRow({ membership }: { membership: Membership }) {
  const t = useTranslations("members");
  const [roleState, roleAction, rolePending] = useActionState(changeMembershipRoleAction, { error: null, values: {} });
  const [removeState, removeAction, removePending] = useActionState(removeMembershipAction, { error: null, values: {} });
  return (
    <li className="panel">
      <strong>{membership.email}</strong>
      <form action={roleAction} className="form-row">
        <input type="hidden" name="membershipId" value={membership.id} />
        <label className="iv-field-label">
          {t("role")}
          <select name="role" defaultValue={membership.role}>
            <option value="administrator">{t("administrator")}</option>
            <option value="user">{t("user")}</option>
          </select>
        </label>
        <Button type="submit" disabled={rolePending}>{t("changeRole")}</Button>
      </form>
      <FormError error={roleState.error} />
      <form action={removeAction}>
        <input type="hidden" name="membershipId" value={membership.id} />
        <Button type="submit" variant="danger" disabled={removePending}>{t("remove")}</Button>
      </form>
      <FormError error={removeState.error} />
    </li>
  );
}

export function MemberManagement({
  organizationId,
  companyId,
  memberships,
}: {
  organizationId: string;
  companyId: string | null;
  memberships: Membership[];
}) {
  const t = useTranslations("members");
  const [state, action, pending] = useActionState(inviteMemberAction, { error: null, values: {} });
  return (
    <>
      <section className="panel">
        <h2>{t("inviteTitle")}</h2>
        <form action={action} className="form">
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
        <h2>{t("currentTitle")}</h2>
        {memberships.length === 0 ? <p>{t("none")}</p> : (
          <ul className="member-list">{memberships.map((membership) => <MembershipRow key={membership.id} membership={membership} />)}</ul>
        )}
      </section>
    </>
  );
}
