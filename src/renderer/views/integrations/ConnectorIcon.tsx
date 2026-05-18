/**
 * Tiny brand badge for a connector row. Letter mark on a brand-color
 * tile. Avoids embedding actual provider logos (trademark exposure +
 * upkeep) while still being recognizable at a glance. Used in both
 * the "Connected accounts" rows and the migration banner.
 */

interface BrandStyle {
  letter: string;
  background: string;
  color: string;
}

const STYLES: Record<string, BrandStyle> = {
  google: { letter: 'G', background: '#4285F4', color: '#fff' },
  slack: { letter: 'S', background: '#4A154B', color: '#fff' },
  notion: { letter: 'N', background: '#000', color: '#fff' },
  linear: { letter: 'L', background: '#5E6AD2', color: '#fff' },
  github: { letter: 'G', background: '#24292f', color: '#fff' },
  'test-echo': {
    letter: 'T',
    background: 'rgba(255,255,255,0.12)',
    color: 'rgba(255,255,255,0.7)',
  },
};

const DEFAULT_STYLE: BrandStyle = {
  letter: '·',
  background: 'rgba(255,255,255,0.08)',
  color: 'rgba(255,255,255,0.65)',
};

export function ConnectorIcon({
  id,
  size = 'md',
}: {
  id: string;
  size?: 'sm' | 'md';
}) {
  const style = STYLES[id] ?? {
    ...DEFAULT_STYLE,
    letter: id.charAt(0).toUpperCase() || '·',
  };
  return (
    <span
      className={`connector-icon connector-icon--${size}`}
      style={{ background: style.background, color: style.color }}
      aria-hidden
    >
      {style.letter}
    </span>
  );
}
