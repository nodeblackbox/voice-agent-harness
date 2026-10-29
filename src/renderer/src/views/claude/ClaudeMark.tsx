/** The Claude starburst, drawn as SVG so it stays crisp at any size and can come alive while a session works. */
export const CLAUDE_ORANGE = '#D97757'

// Irregular rays like the real mark: [angle in degrees, length 0..1]
const RAYS: Array<[number, number]> = [
  [0, 0.96], [29, 0.78], [57, 0.92], [88, 0.7], [118, 0.9], [146, 0.8],
  [178, 0.95], [207, 0.74], [236, 0.88], [266, 0.82], [297, 0.93], [328, 0.76]
]

export function ClaudeMark({ size = 20, working = false, color = CLAUDE_ORANGE, title }: { size?: number; working?: boolean; color?: string; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="-12 -12 24 24"
      role="img"
      aria-label={title ?? 'Claude'}
      className={working ? 'va-claude-working' : undefined}
      style={{ flexShrink: 0, overflow: 'visible' }}
    >
      <g className={working ? 'va-claude-spin' : undefined}>
        {RAYS.map(([a, l]) => {
          const r = (a * Math.PI) / 180
          const len = 10.6 * l
          return (
            <line
              key={a}
              x1={Math.cos(r) * 1.4}
              y1={Math.sin(r) * 1.4}
              x2={Math.cos(r) * len}
              y2={Math.sin(r) * len}
              style={{ stroke: color }}
              strokeWidth={2.5}
              strokeLinecap="round"
            />
          )
        })}
        <circle r={2.3} style={{ fill: color }} />
      </g>
    </svg>
  )
}
