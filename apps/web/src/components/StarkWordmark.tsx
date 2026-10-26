import type { SVGProps } from "react";

/** The public component name stays compatible with upstream call sites. */
export function StarkWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
      <circle cx="64" cy="64" r="47" fill="none" stroke="currentColor" strokeWidth="8" />
    </svg>
  );
}
