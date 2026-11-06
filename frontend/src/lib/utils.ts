/** Joins class names, skipping falsy values. Stands in for shadcn's clsx + tailwind-merge `cn`. */
export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}
