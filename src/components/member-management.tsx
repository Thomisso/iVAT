"use client";

import { useActionState, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { cancelInvitationAction, previewMembershipChangeAction, inviteMemberAction, replaceInvitationAction } from "@/app/actions";
import type { ManagedUser, PendingInvitation, ScopedMembership } from "@/application/memberships";
import { Button } from "./button";
import { FormError } from "./form-error";
import { TextField } from "./text-field";
import { formatDateTime } from "@/lib/format-date";

function MembershipChangeForm({ membership, scope, self, removal = false }: {
  membership: ScopedMembership; scope: string; self: boolean; removal?: boolean;
}) {
  const t = useTranslations("members");
  const triggerForm = useRef<HTMLFormElement>(null);
  const confirmationId = useId();
  const [preview, previewAction, pending] = useActionState(previewMembershipChangeAction, { error: null, values: { role: membership.role }, impact: null });
  const [cancelledPreview, setCancelledPreview] = useState<typeof preview | null>(null);
  const prohibited = self && (removal || membership.role === "administrator");
  const impact = cancelledPreview === preview ? null : preview.impact;
  const label = t(removal ? "removeScope" : "changeScopeRole", { scope });
  return <>
    {!impact && <form ref={triggerForm} action={previewAction} className="form-row" aria-label={label}>
      <input type="hidden" name="membershipId" value={membership.id} />
      {removal ? <input type="hidden" name="role" value="" /> : <label className="iv-field-label">
        {t("role")}
        <select name="role" defaultValue={preview.values.role ?? membership.role} disabled={prohibited || pending}>
          <option value="administrator">{t("administrator")}</option>
          <option value="user">{t("user")}</option>
        </select>
      </label>}
      <Button type="submit" variant={removal ? "danger" : undefined}
        disabled={prohibited || pending} aria-describedby={prohibited ? `${membership.id}-self-hint` : undefined}>{label}</Button>
    </form>}
    <FormError error={preview.error} />
    {impact && <fieldset id={confirmationId} className="form member-change-confirmation">
      <legend>{t("confirmMembershipTitle")}</legend>
      <p>{t("confirmMembershipPerson", { email: impact.membership.email, membership: impact.membership.id })}</p>
      <p>{t("confirmMembershipScope", { scope: t(impact.membership.companyId === null ? "organizationMembership" : "companyMembership", { scope: impact.membership.scopeName }), role: t(impact.membership.role === "administrator" ? "administrator" : "user") })}</p>
      <p>{impact.role === null ? t("confirmMembershipRemoval") : t("confirmMembershipRole", { role: t(impact.role === "administrator" ? "administrator" : "user") })}</p>
      {membership.companyId === null && <p>{t("organizationImpact")}</p>}
      {impact.platformAccess && <p>{t("platformAccessSurvives")}</p>}
      {impact.companies.length === 0 ? <p>{t("noCompanyImpact")}</p> : <ul>
        {impact.companies.map(company => <li key={company.companyId}>
          <strong>{company.name}</strong>
          <p>{impact.platformAccess ? t("platformAccessSurvives") : company.role === null ? t("companyAccessRemoved") : t("companyAccessSurvives", { role: t(company.role === "administrator" ? "administrator" : "user") })}</p>
          {company.memberships.length > 0 && <ul>{company.memberships.map(path => <li key={path.id}>
            {t("survivingMembership", { scope: t(path.source === "company" ? "companyMembership" : "organizationMembership", { scope: path.scopeName }), role: t(path.role === "administrator" ? "administrator" : "user"), membership: path.id })}
          </li>)}</ul>}
        </li>)}
      </ul>}
      <p>{t("revalidatedOnConfirmation")}</p>
      <form action={previewAction} className="form-row">
        <input type="hidden" name="confirm" value="1" />
        <input type="hidden" name="membershipId" value={impact.membership.id} />
        <input type="hidden" name="role" value={impact.role ?? ""} />
        <input type="hidden" name="confirmationToken" value={impact.confirmationToken} />
        <Button type="submit" variant={removal ? "danger" : "primary"} disabled={pending}>{t("confirmMembershipChange")}</Button>
        <Button type="button" disabled={pending} onClick={() => { setCancelledPreview(preview); requestAnimationFrame(() => triggerForm.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus()); }}>{t("cancelMembershipChange")}</Button>
      </form>
    </fieldset>}
  </>;
}

function MembershipRow({ membership, self }: { membership: ScopedMembership; self: boolean }) {
  const t = useTranslations("members");
  const scope = t(membership.source === "company" ? "companyMembership" : "organizationMembership", { scope: membership.scopeName });
  return <li className="member-membership-row">
    <fieldset className="form">
      <legend>{scope}</legend>
      <span>{t(membership.role === "administrator" ? "administrator" : "user")}</span>
      <span className="member-access-source">{t(`source.${membership.source}`)}</span>
      {!membership.manageable && <p>{t("inheritedManagementHint")}</p>}
      {self && <p id={`${membership.id}-self-hint`}>{t("selfChangeHint")}</p>}
      {membership.manageable && <>
        {membership.companyId !== null && <MembershipChangeForm membership={membership} scope={scope} self={self} />}
        <MembershipChangeForm membership={membership} scope={scope} self={self} removal />
      </>}
    </fieldset>
  </li>;
}

function ManagedUserRow({ access, currentUserId }: { access: ManagedUser; currentUserId: string }) {
  const t = useTranslations("members");
  const scopes = access.memberships.map(membership => t(
    membership.source === "company" ? "companyMembership" : "organizationMembership", { scope: membership.scopeName },
  )).join("; ");
  return <li className="panel member-access-row">
    <strong>{access.email}</strong>
    <p className="member-effective-access">{access.effectiveRole ? t("effectiveAccess", { role: t(access.effectiveRole === "administrator" ? "administrator" : "user"), scopes }) : t("organizationAccess", { scopes })}</p>
    <ul className="member-list">{access.memberships.map(membership => <MembershipRow key={membership.id} membership={membership} self={access.userId === currentUserId} />)}</ul>
  </li>;
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
  currentUserId,
  users,
  pendingInvitations,
  acceptUrl,
}: {
  organizationId: string;
  companyId: string | null;
  currentUserId: string;
  users: ManagedUser[];
  pendingInvitations: PendingInvitation[];
  acceptUrl: string | null;
}) {
  const t = useTranslations("members");
  const [state, action, pending] = useActionState(inviteMemberAction, { error: null, values: {} });
  const activeCount = users.length;
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
        <p>{t("activeCount", { count: activeCount })}</p>
        <p>{t("scopedAccessIntro")}</p>
        {activeCount === 0 ? <p>{t("none")}</p> : (
          <ul className="member-list">{users.map(access => <ManagedUserRow key={access.userId} access={access} currentUserId={currentUserId} />)}</ul>
        )}
      </section>
      <section>
        <h2>{t("pendingTitle")}</h2>
        <p>{t("invitationScopeHint")}</p>
        {pendingInvitations.length === 0 ? <p>{t("pendingNone")}</p> : <ul className="member-list">
          {pendingInvitations.map((invitation) => <InvitationRow invitation={invitation} acceptUrl={acceptUrl} key={invitation.id} />)}
        </ul>}
      </section>
    </div>
  );
}
