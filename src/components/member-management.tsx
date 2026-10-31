"use client";

import { useActionState, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { cancelInvitationAction, changeMembershipRoleAction, inviteMemberAction, removeMembershipAction, replaceInvitationAction } from "@/app/actions";
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

function InvitationRow({ invitation, acceptUrl }: { invitation: PendingInvitation; acceptUrl: string | null }) {
  const t = useTranslations("members");
  const [cancelState, cancelAction, cancelling] = useActionState(cancelInvitationAction, { error: null, values: {} });
  const [replaceState, replaceAction, replacing] = useActionState(replaceInvitationAction, { error: null, values: {} });
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const [confirmingCancellation, setConfirmingCancellation] = useState(false);
  const cancelTrigger = useRef<HTMLButtonElement>(null);
  const confirmationId = useId();
  const linkInput = useRef<HTMLInputElement>(null);
  const link = acceptUrl && invitation.token ? `${acceptUrl}#${new URLSearchParams({ token: invitation.token })}` : null;
  const available = invitation.status === "pending" || invitation.status === "expired";
  return <li className="panel member-invitation-row">
    <strong>{invitation.email}</strong>
    <span>{t(invitation.role === "administrator" ? "administrator" : "user")}</span>
    <span>{t(`invitationStatus.${invitation.status}`)}</span>
    <span>{t("expires", { date: formatDateTime(invitation.expiresAt) })}</span>
    {link && <label className="iv-field-label invitation-link-field">
      {t("invitationLink")}<input ref={linkInput} value={link} readOnly type="url" />
    </label>}
    {link && <Button type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(link); setCopied(true); setManualCopy(false); }
      catch { linkInput.current?.focus(); linkInput.current?.select(); setManualCopy(true); }
    }}>{t("copyLink")}</Button>}
    <span role="status">{link && (copied ? t("linkCopied") : manualCopy ? t("copyManually") : "")}</span>
    {available && <>
      {!link && invitation.status === "pending" && <p>{t("legacyLinkIntro")}</p>}
      <form action={replaceAction}>
        <input type="hidden" name="invitationId" value={invitation.id} />
        <Button type="submit" disabled={replacing || cancelling}>{t("replaceLink")}</Button>
      </form>
      <Button type="button" variant="danger" disabled={replacing || cancelling}
        aria-expanded={confirmingCancellation} aria-controls={confirmingCancellation ? confirmationId : undefined}
        onClick={event => { cancelTrigger.current = event.currentTarget; setConfirmingCancellation(true); }}>
        {t("cancelInvitation")}
      </Button>
      {confirmingCancellation && <fieldset id={confirmationId} className="form">
        <legend>{t("cancelInvitationTitle")}</legend>
        <p>{t("cancelInvitationHint")}</p>
        <form action={cancelAction} className="form-row">
          <input type="hidden" name="invitationId" value={invitation.id} />
          <Button type="submit" variant="danger" disabled={replacing || cancelling}>{t("confirmCancellation")}</Button>
          <Button type="button" disabled={replacing || cancelling} onClick={() => {
            setConfirmingCancellation(false); cancelTrigger.current?.focus();
          }}>{t("keepInvitation")}</Button>
        </form>
      </fieldset>}
      <FormError error={replaceState.error ?? cancelState.error} />
    </>}
  </li>;
}

export function MemberManagement({
  organizationId,
  companyId,
  memberships,
  companyAccess,
  pendingInvitations,
  acceptUrl,
}: {
  organizationId: string;
  companyId: string | null;
  memberships?: Membership[];
  companyAccess?: CompanyAccess[];
  pendingInvitations: PendingInvitation[];
  acceptUrl: string | null;
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
          <div className="form-row">
            <Button type="submit" name="delivery" value="email" variant="primary" disabled={pending}>{t("invite")}</Button>
            <Button type="submit" name="delivery" value="link" disabled={pending}>{t("generateLink")}</Button>
          </div>
        </form>
      </section>
      <section>
        <h2>{t("activeTitle")}</h2>
        <p>{t("activeCount", { count: activeAccess.length })}</p>
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
          {pendingInvitations.map((invitation) => <InvitationRow invitation={invitation} acceptUrl={acceptUrl} key={invitation.id} />)}
        </ul>}
      </section>
    </div>
  );
}
