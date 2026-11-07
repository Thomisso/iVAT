"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { Party, ExtractionPayload } from "@/application/extraction-payload";
import type { Counterparty } from "@/application/counterparties";
import { searchDocumentCounterparties } from "./counterparty-link-actions";
import { Button } from "@/components/button";

/** Selecting an identity only changes the link; Party inputs keep their values. */
export function CounterpartyLinkFields({ companyId, initialId, initialName, currentDirectory }: {
  companyId: string; initialId: string; initialName?: string | null; currentDirectory?: ExtractionPayload["counterpartyLink"] | null;
}) {
  const t = useTranslations("review.directory");
  const [selected, setSelected] = useState<{ id: string; name: string; party?: Party }>({ id: initialId, name: initialName ?? "", party: currentDirectory?.recorded });
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<Counterparty[]>([]);
  const [searched, setSearched] = useState(false);
  const [pending, startTransition] = useTransition();
  function choose(entry: { id: string; name: string; party?: Party }, event: FormEvent<HTMLButtonElement>) {
    setSelected(entry);
    // Let the enclosing review's dirty-input protection observe link edits.
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
  return <fieldset>
    <legend>{t("title")}</legend>
    <p>{t("linkHint")}</p>
    <input type="hidden" name="counterpartyId" value={selected.id} />
    {selected.id && <p>{t("selected")}: {selected.name} <Button type="button" variant="secondary" onClick={event => choose({ id: "", name: "" }, event)}>{t("clear")}</Button></p>}
    <label className="iv-field-label" htmlFor="counterparty-search">{t("search")}</label>
    <input id="counterparty-search" className="iv-input" value={query} onChange={event => setQuery(event.target.value)} />
    <Button type="button" variant="secondary" disabled={pending} onClick={() => startTransition(async () => {
      const result = await searchDocumentCounterparties(companyId, query);
      setEntries(result.entries);
      setSearched(true);
    })}>{t("searchAction")}</Button>
    {selected.id && copyParty && <Button type="button" variant="secondary" onClick={copy}>{t("copy")}</Button>}
    <ul>{entries.map(entry => <li key={entry.id}>
      <Button type="button" variant="secondary" onClick={event => choose({ id: entry.id, name: entry.name, party: { name: entry.name, ico: entry.ico, vatId: entry.vatId, street: entry.street || null, city: entry.city || null, postalCode: entry.postalCode || null, country: entry.countryCode || null } }, event)}>{t("choose", { name: entry.name })}</Button>
      {entry.ico && <span> {entry.ico}</span>}{entry.vatId && <span> {entry.vatId}</span>}
    </li>)}</ul>
    {searched && entries.length === 0 && <p role="status">{t("empty")}</p>}
  </fieldset>;
}
