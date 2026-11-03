"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { ContextNavigationItem } from "./app-shell";

export function SettingsSectionNavigation({ items, label }: {
  items: ContextNavigationItem[];
  label: string;
}) {
  const navigation = useRef<HTMLElement>(null);
  const currentHref = items.find((item) => item.current)?.href;

  useEffect(() => {
    const nav = navigation.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const revealCurrent = () => {
      if (nav.scrollWidth <= nav.clientWidth) return;
      const bounds = nav.getBoundingClientRect();
      const link = active.getBoundingClientRect();
      if (link.left < bounds.left) nav.scrollLeft += link.left - bounds.left;
      else if (link.right > bounds.right) nav.scrollLeft += link.right - bounds.right;
    };
    revealCurrent();
    const resize = new ResizeObserver(revealCurrent);
    resize.observe(nav);
    resize.observe(active);
    return () => resize.disconnect();
  }, [currentHref]);

  return <nav aria-label={label} className="settings-section-nav" ref={navigation}>
    {items.map((item) => <Link
      aria-current={item.current ? "page" : undefined}
      href={item.href}
      key={item.href}
    >
      {item.label}
      {item.assistiveDescription && <span className="sr-only"> {item.assistiveDescription}</span>}
      {item.badge !== undefined && item.badge > 0 && <span aria-hidden="true" className="context-navigation-count">{item.badge}</span>}
    </Link>)}
  </nav>;
}
