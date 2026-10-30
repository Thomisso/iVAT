const icons = {
  check: ["M3.5 8.5l3 3 6-7"],
  remove: ["M4 4l8 8", "M12 4l-8 8"],
  alert: ["M8 2.5l6 11H2z", "M8 6.5v3", "M8 11.6v.01"],
  info: ["M8 14a6 6 0 100-12 6 6 0 000 12z", "M8 7.5V11", "M8 5v.01"],
  error: ["M8 14a6 6 0 100-12 6 6 0 000 12z", "M6 6l4 4", "M10 6l-4 4"],
  marker: ["M10.5 2.5l3 3-6 6h-3v-3z", "M8.5 4.5l3 3", "M2 14h7"],
  upload: ["M8 10.5V2.5", "M5 5.5l3-3 3 3", "M2.5 10.5v3h11v-3"],
  file: ["M4 1.5h5l3 3v10H4z", "M9 1.5v3h3"],
  search: ["M7 11.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9z", "M10.5 10.5l3 3"],
  lock: [
    "M4.5 7h7a1 1 0 011 1v5a1 1 0 01-1 1h-7a1 1 0 01-1-1V8a1 1 0 011-1z",
    "M5.5 7V5a2.5 2.5 0 015 0v2",
  ],
  chevron: ["M4 6l4 4 4-4"],
  duplicate: [
    "M6 5h7a.5.5 0 01.5.5v8a.5.5 0 01-.5.5H6a.5.5 0 01-.5-.5v-8A.5.5 0 016 5z",
    "M3.5 11V2.5h7",
  ],
  inbox: ["M2 9.5h3.5l1 2h3l1-2H14", "M2 9.5L4 3h8l2 6.5V13H2z"],
  send: ["M2 8l12-5.5-4.5 12-2-5z", "M7.5 9.5L14 2.5"],
  report: ["M3.5 1.5h9v13h-9z", "M6 5h4", "M6 8h4", "M6 11h2"],
  building: [
    "M3 14V2.5h7V14",
    "M10 6h3v8",
    "M1.5 14h13",
    "M5.5 5h2",
    "M5.5 8h2",
    "M5.5 11h2",
  ],
  split: ["M2.5 8h11", "M4 2.5h8v3H4z", "M4 10.5h8v3H4z"],
  arrow: ["M8 13V3", "M4 7l4-4 4 4"],
  clock: ["M8 14a6 6 0 100-12 6 6 0 000 12z", "M8 4.5V8l2.5 1.5"],
} as const;
export type IconName = keyof typeof icons;
export interface IconProps {
  name: IconName;
  size?: number;
  label?: string;
  className?: string;
}
export function Icon({ name, size = 16, label, className = "" }: IconProps) {
  return (
    <svg
      className={`iv-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {icons[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
