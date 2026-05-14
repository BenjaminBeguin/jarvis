/**
 * Jarvis brand mark. Outer gradient ring breathes, inner dashed ring spins,
 * a J-stroke through the middle, dot at the centre. Drop-shadow does the
 * "alive" thing. Single component — no props.
 */
export function Logo() {
  return (
    <svg className="shell__logo" viewBox="0 0 28 28" aria-hidden>
      <defs>
        <linearGradient id="jLogoGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="1" />
          <stop offset="100%" stopColor="var(--accent-dim, var(--accent))" stopOpacity="0.65" />
        </linearGradient>
      </defs>
      <g className="shell__logo-ring">
        <circle cx="14" cy="14" r="12.5" fill="none" stroke="url(#jLogoGrad)" strokeWidth="1.2" />
      </g>
      <g className="shell__logo-spin">
        <circle
          cx="14"
          cy="14"
          r="9"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="0.8"
          strokeDasharray="2 4"
          opacity="0.55"
        />
      </g>
      <path
        d="M10 7 L18 7 L18 17 Q18 21 14 21 Q10 21 10 17.5"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="14" cy="14" r="1.6" fill="var(--accent)" />
    </svg>
  );
}
