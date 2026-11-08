"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { Party, ExtractionPayload } from "@/application/extraction-payload";
import type { Counterparty } from "@/application/counterparties";
import type { CounterpartyCreationConsent } from "@/application/documents";
import { searchDocumentCounterparties } from "./counterparty-link-actions";
import { Button } from "@/components/button";

function submittedParty(form: HTMLFormElement): CounterpartyCreationConsent | null {
  const values = new FormData(form);
  const direction = values.get("direction");
  if (direction !== "incoming" && direction !== "outgoing") return null;
  const side = direction === "incoming" ? "supplier" : "customer";
  const value = (field: keyof Party) => String(values.get(`${side}.${field}`) ?? "").trim() || null;
  return { direction, party: { name: value("name"), ico: value("ico"), vatId: value("vatId")?.replace(/\s/g, "").toUpperCase() ?? null,
    street: value("street"), city: value("city"), postalCode: value("postalCode"), country: value("country")?.replace(/\s/g, "").toUpperCase() ?? null } };
}

/** Selection, creation consent and copying are distinct human decisions. */
export function CounterpartyLinkFields({ companyId, initialId, initialName, initialMode, currentDirectory }: {
  companyId: string; initialId: string; initialName?: string | null; initialMode?: string; currentDirectory?: ExtractionPayload["counterpartyLink"];
}) {
  const t = useTranslations("review.directory");
  const fieldset = useRef<HTMLFieldSetElement>(null);
  const [selected, setSelected] = useState<{ id: string; name: string; party?: Party }>({ id: initialId, name: initialName ?? "", party: currentDirectory?.recorded });
  const [mode, setMode] = useState(initialMode ?? (initialId ? "selected" : "automatic"));
  const [identity, setIdentity] = useState<CounterpartyCreationConsent | null>(null);
  const [consent, setConsent] = useState<string>("");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<Counterparty[]>([]);
  const [searched, setSearched] = useState(false);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const form = fieldset.current?.form;
    if (!form) return;
    function observe() {
      const current = submittedParty(form!);
      setIdentity(current);
      // Editing either the Party or Direction revokes the exact consent.
      setConsent(previous => previous && previous === JSON.stringify(current) ? previous : "");
    }
    observe();
    form.addEventListener("input", observe);
    form.addEventListener("change", observe);
    return () => { form.removeEventListener("input", observe); form.removeEventListener("change", observe); };
  }, []);
  function choose(entry: { id: string; name: string; party?: Party }, event: FormEvent<HTMLButtonElement>, nextMode = entry.id ? "selected" : "unlinked") {
    setSelected(entry);
    setMode(nextMode);
    setConsent("");
    event.currentTarget.form?.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const copyParty = selected.id === currentDirectory?.id ? currentDirectory.recorded : selected.party;
  function copy(event: FormEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    if (!form || !copyParty) return;
    const direction = form.elements.namedItem("direction");
    const side = direction instanceof HTMLSelectElement && direction.value === "incoming" ? "supplier"
      : direction instanceof HTMLSelectElement && direction.value === "outgoing" ? "customer" : null;
    if (!side) return;
    for (const [field, value] of Object.entries(copyParty)) {
      const input = form.elements.namedItem(`${side}.${field}`);
      if (input instanceof HTMLInputElement) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value ?? "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }
  function search(identifiers?: { ico?: string; vatId?: string }) {
    startTransition(async () => {
      const result = await searchDocumentCounterparties(companyId, identifiers ? "" : query, identifiers);
      setEntries(result.entries);
      setSearched(true);
    });
  }
  const identifiers = { ico: identity?.party.ico ?? "", vatId: identity?.party.vatId ?? "" };
  const hasIdentifiers = Boolean(identifiers.ico || identifiers.vatId);
  return <fieldset ref={fieldset}>
    <legend>{t("title")}</legend>
    <p>{t("linkHint")}</p>
    <input type="hidden" name="counterpartyId" value={selected.id} />
    <input type="hidden" name="counterpartyLinkMode" value={mode} />
    <input type="hidden" name="counterpartyCreationConsent" value={consent} />
    {selected.id && <p>{t("selected")}: {selected.name} <Button type="button" variant="secondary" onClick={event => choose({ id: "", name: "" }, event)}>{t("clear")}</Button></p>}
    {!selected.id && mode === "unlinked" && <p role="status">{t("unlinked")} <Button type="button" variant="secondary" onClick={event => choose({ id: "", name: "" }, event, "automatic")}>{t("automatic")}</Button></p>}
    {!selected.id && identity && !hasIdentifiers && <label className="iv-field-label">
      <input type="checkbox" checked={Boolean(consent)} onChange={event => {
        const form = event.currentTarget.form;
        setConsent(event.currentTarget.checked && form ? JSON.stringify(submittedParty(form)) : "");
      }} /> {t("confirmWithoutIdentity")}
    </label>}
    <label className="iv-field-label" htmlFor="counterparty-search">{t("search")}</label>
    <input id="counterparty-search" className="iv-input" value={query} onChange={event => setQuery(event.target.value)} />
    <Button type="button" variant="secondary" disabled={pending} onClick={() => search()}>{t("searchAction")}</Button>
    {hasIdentifiers && <>
      <Button type="button" variant="secondary" disabled={pending} onClick={() => search(identifiers)}>{t("findIdentity")}</Button>
      <Link href={`/companies/${companyId}/counterparties?${new URLSearchParams({ state: "archived", ...identifiers })}`}>{t("archivedIdentity")}</Link>
    </>}
    {selected.id && copyParty && <Button type="button" variant="secondary" onClick={copy}>{t("copy")}</Button>}
    <ul>{entries.map(entry => <li key={entry.id}>
      <Button type="button" variant="secondary" onClick={event => choose({ id: entry.id, name: entry.name, party: { name: entry.name, ico: entry.ico, vatId: entry.vatId, street: entry.street || null, city: entry.city || null, postalCode: entry.postalCode || null, country: entry.countryCode || null } }, event)}>{t("choose", { name: entry.name })}</Button>
      {entry.ico && <span> {entry.ico}</span>}{entry.vatId && <span> {entry.vatId}</span>}
    </li>)}</ul>
    {searched && entries.length === 0 && <p role="status">{t("empty")}</p>}
  </fieldset>;
}
