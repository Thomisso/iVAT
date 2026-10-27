"use client";

import { useActionState, type ReactNode } from "react";
import type { FormState } from "@/app/actions";
import { FormError } from "./form-error";

/** A one-button form that runs a server action on the current page and shows its refusal. */
export function CommandButton({
  action,
  fields,
  children,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  fields: Record<string, string>;
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null, values: {} });
  return (
    <form action={formAction} className="command">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" disabled={pending}>
        {children}
      </button>
      <FormError error={state.error} />
    </form>
  );
}
