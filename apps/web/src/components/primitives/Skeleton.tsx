/** Shimmer placeholder — size via className (e.g. "h-8 w-32"). Page loads use these, never spinners. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}
