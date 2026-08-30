/**
 * Charts for the benchmark screen.
 *
 * Hand-drawn SVG rather than a charting library: the shapes here are simple,
 * and drawing them directly means they inherit the app's tokens, respond to
 * both themes, and add nothing to the bundle. Every chart carries a text
 * alternative, since a bar length is not information for a screen reader.
 */

import { type ReactNode } from 'react';

/* ── Horizontal bar comparison ──────────────────────────────────────── */

export interface BarDatum {
  label: string;
  value: number;
  /** Secondary line under the label, e.g. the compute backend. */
  detail?: string;
  tone?: 'ember' | 'remote' | 'muted';
}

export interface BarChartProps {
  data: readonly BarDatum[];
  unit: string;
  caption: string;
}

export function BarChart({ data, unit, caption }: BarChartProps): ReactNode {
  if (data.length === 0) return null;

  const max = Math.max(...data.map((datum) => datum.value), 1);
  const rowHeight = 40;
  const height = data.length * rowHeight;
  const labelWidth = 132;
  const width = 420;
  const trackWidth = width - labelWidth - 52;

  return (
    <figure style={{ margin: 0 }}>
      <div className="scroll-x">
        <svg
          className="chart"
          viewBox={`0 0 ${width} ${height}`}
          style={{ minWidth: 320 }}
          role="img"
          aria-label={caption}
        >
          {data.map((datum, index) => {
            const y = index * rowHeight;
            const barWidth = Math.max(2, (datum.value / max) * trackWidth);
            return (
              <g key={`${datum.label}-${index}`}>
                <text className="chart__axis" x={0} y={y + 15} style={{ fontSize: 10 }}>
                  {truncate(datum.label, 20)}
                </text>
                {datum.detail ? (
                  <text className="chart__axis" x={0} y={y + 27} style={{ fontSize: 8.5 }}>
                    {datum.detail}
                  </text>
                ) : null}
                <rect
                  x={labelWidth}
                  y={y + 8}
                  width={trackWidth}
                  height={14}
                  rx={3}
                  fill="var(--surface-3)"
                />
                <rect
                  className="chart__bar"
                  data-tone={datum.tone === 'ember' ? undefined : datum.tone}
                  x={labelWidth}
                  y={y + 8}
                  width={barWidth}
                  height={14}
                  rx={3}
                />
                <text
                  className="chart__axis"
                  x={labelWidth + trackWidth + 6}
                  y={y + 19}
                  style={{ fontSize: 10, fill: 'var(--ink-2)' }}
                >
                  {datum.value.toFixed(1)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="chart-caption">
        {caption} — {unit}.
      </figcaption>
    </figure>
  );
}

/* ── Sparkline of repeated samples ──────────────────────────────────── */

export interface SparklineProps {
  values: readonly number[];
  label: string;
  unit?: string;
}

export function Sparkline({ values, label, unit }: SparklineProps): ReactNode {
  if (values.length < 2) return null;

  const width = 200;
  const height = 44;
  const pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const points = values.map((value, index) => {
    const x = pad + (index / (values.length - 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });

  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width - pad} ${height - pad} L${pad} ${height - pad} Z`;
  const last = points[points.length - 1];

  return (
    <figure style={{ margin: 0 }}>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${label}: ${values.map((value) => value.toFixed(1)).join(', ')}${unit ? ` ${unit}` : ''}`}
      >
        <path className="chart__area" d={area} />
        <path className="chart__line" d={line} />
        {last ? <circle className="chart__endpoint" cx={last[0]} cy={last[1]} r={3} /> : null}
      </svg>
      <figcaption className="chart-caption" style={{ marginTop: 2 }}>
        {label} — {min.toFixed(1)}–{max.toFixed(1)}
        {unit ? ` ${unit}` : ''}
      </figcaption>
    </figure>
  );
}

/* ── Thermal arc ────────────────────────────────────────────────────── */

export function ThermalArc({ level, label }: { level: number; label: string }): ReactNode {
  const size = 92;
  const radius = 36;
  const centre = size / 2;
  const clamped = Math.min(1, Math.max(0, level));

  // Three-quarter arc, opening at the bottom.
  const start = Math.PI * 0.75;
  const sweep = Math.PI * 1.5;
  const end = start + sweep * clamped;

  const point = (angle: number): string => {
    const x = centre + radius * Math.cos(angle);
    const y = centre + radius * Math.sin(angle);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  };

  const tone = clamped > 0.8 ? 'var(--crit)' : clamped > 0.55 ? 'var(--warn)' : 'var(--good)';

  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${label}: ${Math.round(clamped * 100)} percent`}
      >
        <path
          d={`M${point(start)} A${radius} ${radius} 0 1 1 ${point(start + sweep)}`}
          fill="none"
          stroke="var(--surface-3)"
          strokeWidth={7}
          strokeLinecap="round"
        />
        {clamped > 0.01 ? (
          <path
            d={`M${point(start)} A${radius} ${radius} 0 ${sweep * clamped > Math.PI ? 1 : 0} 1 ${point(end)}`}
            fill="none"
            stroke={tone}
            strokeWidth={7}
            strokeLinecap="round"
          />
        ) : null}
        <text
          x={centre}
          y={centre + 5}
          textAnchor="middle"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 17,
            fill: 'var(--ink)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {Math.round(clamped * 100)}
        </text>
      </svg>
      <figcaption className="readout">{label}</figcaption>
    </figure>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
