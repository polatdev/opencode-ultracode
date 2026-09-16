export function fmtTokens(n: number | undefined): string {
  if (!n) return "0 tok"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`
  return `${Math.round(n)} tok`
}

export function fmtDuration(ms: number | undefined, maxMs?: number): string {
  if (ms == null) return "—"
  const t = maxMs != null ? Math.min(ms, maxMs) : ms
  if (t < 1000) return "0s"
  const s = Math.floor(t / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h ${rm}m` : `${h}h`
}

/** elapsed for a still-running agent */
export function fmtElapsed(startedAt: number | undefined, endedAt: number | undefined, now: number): string {
  return fmtDuration(endedAt != null ? endedAt - (startedAt ?? endedAt) : startedAt ? now - startedAt : undefined)
}

/** "anthropic/claude-sonnet-4-6" -> "claude-sonnet-4-6"; keeps provider for unknown tiers */
export function shortModel(model: string | undefined): string {
  if (!model) return "default"
  const i = model.indexOf("/")
  return i >= 0 ? model.slice(i + 1) : model
}

/** clamp a string to n chars with an ellipsis */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}
