/** A person's profile picture, or their initial on a raised green tile when they have none. */
export default function Avatar({ name, src, size = 28, className = "" }: { name: string; src: string | null | undefined; size?: number; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const box = { width: size, height: size };
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data: URL, nothing for next/image to optimise
      <img src={src} alt="" width={size} height={size} style={box} className={`shrink-0 rounded-full object-cover ring-2 ring-paper/70 shadow-md ${className}`} />
    );
  }
  return (
    <span aria-hidden style={{ ...box, fontSize: Math.round(size * 0.42) }} className={`icon-tile shrink-0 rounded-full bg-brand font-bold text-ink ${className}`}>
      {initial}
    </span>
  );
}
