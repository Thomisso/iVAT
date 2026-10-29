"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEventHandler,
} from "react";
import { useTranslations } from "next-intl";
import { Icon } from "./icon";

export interface DropZoneProps {
  title?: string;
  hint?: string;
  accept?: string;
  over?: boolean;
  onFiles?: ChangeEventHandler<HTMLInputElement>;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  multiple?: boolean;
}

/** The picker and drag-and-drop share the same accept rules. Server-side content validation remains authoritative. */
export function acceptsFile(file: Pick<File, "name" | "type">, accept: string) {
  return accept.split(",").some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith(".")) return file.name.toLowerCase().endsWith(rule);
    if (rule.endsWith("/*"))
      return file.type.toLowerCase().startsWith(rule.slice(0, -1));
    return file.type.toLowerCase() === rule;
  });
}

export function DropZone({
  title,
  hint,
  accept = ".pdf,.png,.jpg,.jpeg,.heic,.heif,.xlsx,.xls",
  over,
  onFiles,
  name = "file",
  required,
  disabled,
  multiple = false,
}: DropZoneProps) {
  const t = useTranslations("sourceFiles");
  const errors = useTranslations("errors");
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [names, setNames] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const form = input.current?.form;
    const reset = () => {
      setNames("");
      setError("");
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, []);

  return (
    <div className="iv-stack">
      <label
        className={`iv-drop ${over || dragging ? "is-over" : ""} ${disabled ? "is-disabled" : ""}`}
        htmlFor={id}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (disabled || !input.current) return;
          const files = Array.from(event.dataTransfer.files);
          if (!files.length) return;
          if (
            files.some((file) => !acceptsFile(file, accept)) ||
            (!multiple && files.length > 1)
          ) {
            input.current.value = "";
            setNames("");
            setError(
              errors(
                files.length > 1 && !multiple
                  ? "one_file_required"
                  : "unsupported_format",
              ),
            );
            return;
          }
          input.current.files = event.dataTransfer.files;
          input.current.dispatchEvent(new Event("change", { bubbles: true }));
        }}
      >
        <span className="iv-drop-icon">
          <Icon name="upload" size={20} />
        </span>
        <span className="iv-drop-text">
          <span className="iv-drop-title">{title ?? t("dropTitle")}</span>
          <span id={`${id}-hint`} className="iv-drop-hint">
            {hint ?? t("fileHint")}
          </span>
          {names && (
            <span className="iv-mono" aria-live="polite">
              {names}
            </span>
          )}
        </span>
        <input
          ref={input}
          id={id}
          className="sr-only"
          type="file"
          name={name}
          accept={accept}
          required={required}
          disabled={disabled}
          multiple={multiple}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          aria-invalid={!!error}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            if (files.some((file) => !acceptsFile(file, accept))) {
              event.currentTarget.value = "";
              setNames("");
              setError(errors("unsupported_format"));
              return;
            }
            setError("");
            setNames(files.map((file) => file.name).join(", "));
            onFiles?.(event);
          }}
        />
        <span className="iv-btn iv-btn-sm" aria-hidden="true">
          {t("chooseFile")}
        </span>
      </label>
      {error && (
        <span id={`${id}-error`} className="iv-field-error" role="alert">
          <Icon name="error" />
          {error}
        </span>
      )}
    </div>
  );
}
