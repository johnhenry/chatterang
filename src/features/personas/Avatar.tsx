import { type ReactNode } from 'react';

import type { Persona } from '@/domain/persona';

/**
 * Persona avatar.
 *
 * When no image is set, draws a deterministic mark from the persona's seed
 * rather than showing initials in a coloured circle — which every app does,
 * and which makes a list of personas look like a list of contacts. The marks
 * are concentric arcs whose angles and hue come from the seed, so the same
 * persona always looks the same and different personas look different.
 */
export function Avatar({ persona, size = 40 }: { persona: Persona; size?: number }): ReactNode {
  if (persona.avatar) {
    return (
      <img
        src={persona.avatar}
        alt=""
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          borderRadius: 'var(--r-sm)',
          objectFit: 'cover',
          flex: 'none',
          border: '1px solid var(--line)',
        }}
      />
    );
  }

  const seed = hash(persona.avatarSeed || persona.name);
  const rings = 3 + (seed % 3);
  const rotation = seed % 360;
  // Characters lean cool, assistants lean warm — matching the app's split
  // between the two kinds of persona.
  const hue = persona.kind === 'character' ? 185 + ((seed >> 3) % 40) : 12 + ((seed >> 3) % 36);

  const centre = 24;
  const arcs = Array.from({ length: rings }, (_, index) => {
    const radius = 6 + index * 5.5;
    const sweep = 80 + ((seed >> (index * 4)) % 200);
    const start = (rotation + index * 47) % 360;
    return { radius, sweep, start, index };
  });

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      style={{
        flex: 'none',
        borderRadius: 'var(--r-sm)',
        background: `hsl(${hue} 30% 16%)`,
        border: '1px solid var(--line)',
      }}
    >
      {arcs.map(({ radius, sweep, start, index }) => (
        <path
          key={index}
          d={arcPath(centre, centre, radius, start, start + sweep)}
          fill="none"
          stroke={`hsl(${hue + index * 9} ${58 - index * 8}% ${62 - index * 6}%)`}
          strokeWidth={2.6}
          strokeLinecap="round"
        />
      ))}
      <circle cx={centre} cy={centre} r={2} fill={`hsl(${hue} 70% 68%)`} />
    </svg>
  );
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const toRad = (deg: number): number => ((deg - 90) * Math.PI) / 180;
  const start = { x: cx + r * Math.cos(toRad(startDeg)), y: cy + r * Math.sin(toRad(startDeg)) };
  const end = { x: cx + r * Math.cos(toRad(endDeg)), y: cy + r * Math.sin(toRad(endDeg)) };
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M${start.x.toFixed(2)} ${start.y.toFixed(2)} A${r} ${r} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
