"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDate, parseDateInput } from "@/lib/format-date";
import { TextField, type TextFieldProps } from "./text-field";

export interface DateInputProps
  extends Omit<TextFieldProps, "type" | "name" | "defaultValue" | "value" | "onChange"> {
  name: string;
  /** The stored calendar date (yyyy-mm-dd), or empty. */
  defaultValue?: string;
}

function shown(value: string) {
  try {
    return value ? formatDate(value) : "";
  } catch {
    return value;
  }
}

/**
 * The one date input of the application. The User types dd.mm.rrrr whatever
 * the browser locale; the form submits the calendar date (yyyy-mm-dd) under
 * `name`, so actions and filters keep reading ISO dates.
 */
export function DateInput({ name, defaultValue = "", error, ...props }: DateInputProps) {
  const t = useTranslations("dateInput");
  const visible = useRef<HTMLInputElement>(null);
  const [submitted, setSubmitted] = useState(defaultValue);
  const [invalid, setInvalid] = useState(false);

  const read = (input: HTMLInputElement) => {
    const parsed = parseDateInput(input.value);
    setSubmitted(parsed.ok ? parsed.value : input.value);
    input.setCustomValidity(parsed.ok ? "" : t("invalid"));
    setInvalid(!parsed.ok);
  };

  // A form reset restores the typed text; the submitted value follows it.
  useEffect(() => {
    const form = visible.current?.form;
    if (!form) return;
    const reset = () => {
      setSubmitted(defaultValue);
      visible.current?.setCustomValidity("");
      setInvalid(false);
    };
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [defaultValue]);

  return (
    <>
      <TextField
        {...props}
        ref={visible}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={t("placeholder")}
        defaultValue={shown(defaultValue)}
        error={invalid ? t("invalid") : error}
        onChange={(event) => read(event.currentTarget)}
      />
      <input type="hidden" name={name} value={submitted} disabled={props.disabled} />
    </>
  );
}
