"use client";

import { useId, type InputHTMLAttributes } from "react";
import { Icon } from "./icon";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
  mono?: boolean;
}

export function TextField({
  label,
  hint,
  error,
  mono,
  id,
  className = "",
  "aria-describedby": describedBy,
  ...props
}: TextFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const messageId = error
    ? `${fieldId}-error`
    : hint
      ? `${fieldId}-hint`
      : undefined;
  return (
    <div className={`iv-field ${error ? "is-invalid" : ""} ${className}`}>
      <label className="iv-field-label" htmlFor={fieldId}>
        {label}
      </label>
      <input
        {...props}
        id={fieldId}
        className={`iv-input ${mono ? "iv-mono" : ""}`}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={
          [describedBy, messageId].filter(Boolean).join(" ") || undefined
        }
      />
      {error ? (
        <span id={messageId} className="iv-field-error" role="alert">
          <Icon name="error" />
          {error}
        </span>
      ) : hint ? (
        <span id={messageId} className="iv-field-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
