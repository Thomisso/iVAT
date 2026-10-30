"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDate, parseDateInput } from "@/lib/format-date";
import { TextField, type TextFieldProps } from "./text-field";

export interface DateInputProps
  extends Omit<TextFieldProps, "type" | "name" | "defaultValue" | "value" | "onChange" | "trailingControl"> {
  name: string;
  /** The stored calendar date (yyyy-mm-dd), or empty. */
  defaultValue?: string;
}

/**
 * Czech manual entry and native calendar selection share one calendar-date
 * submission (yyyy-mm-dd), independent of the browser's display locale.
 */
export function DateInput({ name, defaultValue = "", error, hint, ...props }: DateInputProps) {
  const t = useTranslations("dateInput");
  const visible = useRef<HTMLInputElement>(null);
  const [submitted, setSubmitted] = useState(defaultValue);
  const [calendarValue, setCalendarValue] = useState(defaultValue);
  const [invalid, setInvalid] = useState(false);

  // Each change updates what the form submits and whether it may submit; the
  // message waits until the User leaves the field or tries to submit.
  const read = (input: HTMLInputElement) => {
    const parsed = parseDateInput(input.value);
    setSubmitted(parsed.ok ? parsed.value : input.value);
    setCalendarValue(parsed.ok ? parsed.value : "");
    input.setCustomValidity(parsed.ok ? "" : t("invalid"));
    setInvalid(false);
  };
  const explain = (input: HTMLInputElement) => {
    setInvalid(!parseDateInput(input.value).ok);
  };

  // A form reset restores the typed text; the submitted value follows it.
  useEffect(() => {
    const form = visible.current?.form;
    if (!form) return;
    const reset = () => {
      setSubmitted(defaultValue);
      setCalendarValue(defaultValue);
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
        autoComplete="off"
        placeholder={t("placeholder")}
        defaultValue={defaultValue ? formatDate(defaultValue) : ""}
        hint={hint}
        error={invalid ? t("invalid") : error}
        onChange={(event) => read(event.currentTarget)}
        onBlur={(event) => explain(event.currentTarget)}
        onInvalid={(event) => explain(event.currentTarget)}
        trailingControl={<input
          type="date"
          className="iv-input iv-date-calendar"
          aria-label={t("calendarFor", { label: props.label })}
          title={t("calendarFor", { label: props.label })}
          value={calendarValue}
          disabled={props.disabled}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (visible.current) {
              visible.current.value = value ? formatDate(value) : "";
              read(visible.current);
            }
          }}
        />}
      />
      <input type="hidden" name={name} value={submitted} disabled={props.disabled} />
    </>
  );
}
