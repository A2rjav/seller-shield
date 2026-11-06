/** Shimmering placeholder block for loading states. */
export default function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div aria-hidden className={`skeleton rounded-md ${className}`} />;
}
