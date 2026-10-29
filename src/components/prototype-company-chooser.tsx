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
  otherInitial: string;
  otherMeta: string;
};

export function PrototypeCompanyChooser({
  chooserLabel,
  currentLabel,
  initial,
  menuLabel,
  meta,
  name,
  otherCompany,
  otherInitial,
  otherMeta,
}: PrototypeCompanyChooserProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const companies = [
    { initial, meta, name },
    { initial: otherInitial, meta: otherMeta, name: otherCompany },
  ];
  const selected = companies[selectedIndex];

  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  function openMenu(index: number) {
    setActiveIndex(index);
    setOpen(true);
  }

  function closeAndRestoreFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function selectCompany(index: number) {
    setSelectedIndex(index);
    closeAndRestoreFocus();
  }

  return (
    <div
      className={styles.companyPicker}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (!open || event.currentTarget === event.target) return;
        if (event.key === "Escape") {
          event.preventDefault();
          closeAndRestoreFocus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActiveIndex((index) => (index + step + companies.length) % companies.length);
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          setActiveIndex(event.key === "Home" ? 0 : companies.length - 1);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectCompany(activeIndex);
        } else if (event.key === "Tab") {
          setOpen(false);
        }
      }}
    >
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className={styles.company}
        onClick={() => open ? closeAndRestoreFocus() : openMenu(selectedIndex)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(event.key === "ArrowDown" ? 0 : companies.length - 1);
          }
        }}
        ref={triggerRef}
        type="button"
      >
        <span className={styles.visuallyHidden}>{chooserLabel}</span>
        <span aria-hidden="true" className={styles.companyInitial}>{selected.initial}</span>
        <span className={styles.companyIdentity}><strong>{selected.name}</strong><small>{selected.meta}</small></span>
        <svg aria-hidden="true" className={styles.icon} viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      {open && (
        <div aria-label={menuLabel} className={styles.companyMenu} role="menu">
          {companies.map((company, index) => (
            <button
              key={company.name}
              onClick={() => selectCompany(index)}
              onFocus={() => setActiveIndex(index)}
              ref={(node) => { itemRefs.current[index] = node; }}
              role="menuitem"
              tabIndex={activeIndex === index ? 0 : -1}
              type="button"
            >
              {company.name} {index === selectedIndex ? currentLabel : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
