import { expect, it } from "vitest";
import { changeMembershipRole, listMemberships, previewMembershipChange, removeMembership } from "@/application/memberships";
import { administratorWithCompany, companyMember } from "../tests/support/fixtures";
import { baseUrl, httpAs, value } from "./support/http";

it("returns localized self-change explanations and scoped action forms without mutating Memberships during review", async () => {
  const owner = await administratorWithCompany("HTTP Membership safety");
  const member = await companyMember(owner, "administrator");
  const [membership] = await listMemberships(owner.client, owner);
  for (const [locale, explanation, action] of [
    ["en", "You cannot remove your own Membership", "Change Role"],
    ["cs", "Vlastní členství nelze odebrat", "Změnit roli"],
  ]) {
    const request = await httpAs(member.client, locale);
    const response = await request(`/companies/${owner.companyId}/settings/users`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(explanation);
    expect(html).toContain(member.email);
    expect(html).toContain(membership.id);
    expect(html).toContain(action);
    expect(html).toContain("disabled");
  }
  const impact = value(await previewMembershipChange(owner.client, { membershipId: membership.id, role: "user" }));
  expect(impact.membership.email).toBe(member.email);
  expect((await listMemberships(owner.client, owner))[0].role).toBe("administrator");
  expect(await changeMembershipRole(member.client, { membershipId: membership.id, role: "user" })).toEqual({ ok: false, error: "membership_self_change" });
  expect(await removeMembership(member.client, membership.id)).toEqual({ ok: false, error: "membership_self_change" });
  const foreign = await administratorWithCompany("HTTP foreign Membership safety");
  const denied = await (await httpAs(foreign.client))(`/companies/${owner.companyId}/settings/users`);
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain(member.email);
});


it("posts the real Membership preview and exact confirmation actions over authenticated HTTP", async () => {
  const owner = await administratorWithCompany("HTTP exact confirmation");
  const member = await companyMember(owner, "administrator");
  const [membership] = await listMemberships(owner.client, owner);
  const request = await httpAs(owner.client);
  const path = `/companies/${owner.companyId}/settings/users`;
  const initial = await request(path);
  const post = (form: FormData) => request(path, { method: "POST", headers: { Origin: baseUrl() }, body: form });
  const preview = await post(membershipForm(await initial.text(), membership.id, false));
  expect(preview.status).toBe(200);
  const reviewed = await preview.text();
  expect(reviewed).toContain("Review Membership change");
  expect(reviewed).toContain(member.email);
  expect(reviewed).toContain("No access to this Company will remain through Memberships.");
  expect(reviewed).toContain("Cancel change");
  expect((await listMemberships(owner.client, owner))[0].role).toBe("administrator");
  value(await changeMembershipRole(owner.client, { membershipId: membership.id, role: "user" }));
  const stale = await post(membershipForm(reviewed, membership.id, true));
  expect(stale.status).toBe(200);
  expect(await stale.text()).toContain("Access changed while you were reviewing.");
  expect((await listMemberships(owner.client, owner))[0].role).toBe("user");
  const current = await request(path);
  const refreshed = await post(membershipForm(await current.text(), membership.id, false));
  expect(refreshed.status).toBe(200);
  const confirmed = await post(membershipForm(await refreshed.text(), membership.id, true));
  expect(confirmed.status).toBe(200);
  expect(await listMemberships(owner.client, owner)).toEqual([]);
  expect(await previewMembershipChange(member.client, { membershipId: membership.id, role: null })).toEqual({ ok: false, error: "forbidden" });
});

/** React's real native action descriptor, submitted without a browser. */
function membershipForm(html: string, membershipId: string, confirmation: boolean) {
  const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g)?.find(item => item.includes(`value="${membershipId}"`)
    && (confirmation ? item.includes('name="confirmationToken"') : item.includes('name="role" value=""')));
  expect(Boolean(form)).toBe(true);
  const data = new FormData();
  const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const input of form!.matchAll(/<input\b[^>]*>/g)) {
    const name = input[0].match(/\bname="([^"]*)"/)?.[1];
    const value = input[0].match(/\bvalue="([^"]*)"/)?.[1] ?? "";
    if (name) data.append(decode(name), decode(value));
  }
  return data;
}
