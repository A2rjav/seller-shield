const PATHS = {
  shield: "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z",
  shieldCheck: "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z M9 12l2 2 4-4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  alert: "M12 4l9 16H3L12 4z M12 10v4 M12 17.5v.5",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18z M12 7v5l3 2",
  bot: "M8 9h8a3 3 0 013 3v4a3 3 0 01-3 3H8a3 3 0 01-3-3v-4a3 3 0 013-3z M12 5v4 M9.5 14h.01 M14.5 14h.01",
  truck: "M3 7h11v9H3z M14 10h4l3 3v3h-7 M7 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3z M17 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
  file: "M7 3h7l5 5v13H7z M14 3v5h5 M10 13h6 M10 17h6",
  refresh: "M20 11a8 8 0 10-2.3 5.7 M20 5v6h-6",
  chevronRight: "M9 6l6 6-6 6",
  arrowLeft: "M19 12H5 M11 6l-6 6 6 6",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6",
  sparkles: "M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8L19 15z",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18z M12 11v5 M12 7.5v.5",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14z M20 20l-4-4",
  upload: "M12 16V4 M7 9l5-5 5 5 M4 20h16",
  package: "M3 7l9-4 9 4v10l-9 4-9-4V7z M3 7l9 4 9-4 M12 11v10",
  key: "M15 9a3 3 0 11-6 0 3 3 0 016 0z M12 12v9 M12 17h3",
  dollar: "M12 3v18 M16 7.5c0-1.4-1.8-2.5-4-2.5s-4 1.1-4 2.5S9.8 10 12 10.5s4 1.1 4 3-1.8 2.5-4 2.5-4-1.1-4-2.5",
  inbox: "M4 13l3-8h10l3 8v6H4v-6z M4 13h5l1 2h4l1-2h5",
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, className = "h-4 w-4", title }: { name: IconName; className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
