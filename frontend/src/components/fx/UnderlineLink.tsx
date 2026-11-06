import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/utils";

/*
 * Underline-wipe links, ported from Skiper UI "skiper40" (Animated Link), which is free to use with attribution.
 * Skiper UI · https://skiper-ui.com · author @gurvinder-singh02. Re-wired to react-router and the app's tokens;
 * the arrow variants are left out on purpose, the design rules keep arrows off link text.
 */
const WIPE =
  "group relative inline-flex items-center before:pointer-events-none before:absolute before:bottom-[-0.12em] before:left-0 before:h-px before:w-full before:bg-current before:content-[''] before:origin-right before:scale-x-0 before:transition-transform before:duration-300 before:ease-[cubic-bezier(0.4,0,0.2,1)] hover:before:origin-left hover:before:scale-x-100 focus-visible:before:origin-left focus-visible:before:scale-x-100 motion-reduce:before:transition-none";

/** Line wipes in from the left on hover, out to the right on leave (Skiper40 Link000). */
export function UnderlineLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={cn(WIPE, className)}>
      {children}
    </Link>
  );
}

/** Same wipe on plain text, growing from the centre (Skiper40 Link003). */
export function UnderlineText({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn(WIPE, "before:origin-center hover:before:origin-center", className)}>{children}</span>;
}
