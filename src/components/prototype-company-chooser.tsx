"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./visual-prototype.module.css";

type PrototypeCompanyChooserProps = {
  chooserLabel: string;
  currentLabel: string;
  initial: string;
  menuLabel: string;
  meta: string;
  name: string;
  otherCompany: string;
};

export function PrototypeCompanyChooser({
  chooserLabel,
  currentLabel,
  initial,
  menuLabel,
  meta,
  name,
  otherCompany,
}: PrototypeCompanyChooserProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const currentRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) currentRef.current?.focus();
  }, [open]);

  function closeAndRestoreFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div
      className={styles.companyPicker}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          closeAndRestoreFocus();
        }
      }}
    >
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${chooserLabel}, ${name}`}
        className={styles.company}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <span className={styles.companyInitial}>{initial}</span>
        <span><strong>{name}</strong><small>{meta}</small></span>
        <svg aria-hidden="true" className={styles.icon} viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      {open && (
        <div aria-label={menuLabel} className={styles.companyMenu} role="menu">
          <button ref={currentRef} role="menuitem" type="button">{name} {currentLabel}</button>
          <button role="menuitem" type="button">{otherCompany}</button>
        </div>
      )}
    </div>
  );
}
