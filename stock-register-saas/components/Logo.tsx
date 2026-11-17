import Link from "next/link";

/** Isometric crate mark + wordmark. Text colour follows the surrounding text. */
export default function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 text-lg font-bold tracking-tight" aria-label="GodownBook home">
      <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden className="shrink-0 drop-shadow-[0_3px_3px_rgb(0_0_0/0.25)]">
        {/* top */}
        <path d="M16 3 L29 10 L16 17 L3 10 Z" fill="#4ade80" />
        {/* left face */}
        <path d="M3 10 L16 17 L16 30 L3 23 Z" fill="#15803d" />
        {/* right face */}
        <path d="M29 10 L16 17 L16 30 L29 23 Z" fill="#0f5c2c" />
        {/* tape */}
        <path d="M9.5 6.5 L22.5 13.5 L22.5 16.5 L9.5 9.5 Z" fill="#ffffff" opacity="0.55" />
        {/* book lines on the left face */}
        <path d="M6 15.5 L13 19.3 M6 18.8 L13 22.6" stroke="#dcfce7" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span>
        Godown<span className="text-brand">Book</span>
      </span>
    </Link>
  );
}
