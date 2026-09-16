export function fmtTokens(n: number | undefined): string {
  if (!n) return "0 tok"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`
  return `${Math.round(n)} tok`
}

/** compact token count for table cells: "58.1k", "1.2M", "512" */
export function fmtTok(n: number | undefined): string {
  if (!n) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

/** "$0.0421", "$1.23", "$0" */
export function fmtCost(n: number | undefined): string {
  if (!n) return "$0"
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
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

/** "just now", "3m ago", "2h ago", "yesterday", "3d ago" */
export function fmtAgo(ts: number | undefined, now: number): string {
  if (!ts) return "—"
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 45) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d === 1) return "yesterday"
  return `${d}d ago`
}

export function fmtClock(ts: number | undefined): string {
  if (!ts) return "—"
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** "anthropic/claude-sonnet-4-6" -> "claude-sonnet-4-6"; keeps provider for unknown tiers */
export function shortModel(model: string | undefined): string {
  if (!model) return "default"
  const i = model.indexOf("/")
  return i >= 0 ? model.slice(i + 1) : model
}

/** clamp a string to n chars with an ellipsis */
export function clip(s: string, n: number): string {
  if (n <= 0) return ""
  if (s.length <= n) return s
  if (n === 1) return "…"
  return s.slice(0, n - 1) + "…"
}

/** clip then pad to exactly n chars (left-aligned) */
export function cell(s: string, n: number): string {
  return clip(s, n).padEnd(n)
}

/** clip then pad to exactly n chars (right-aligned) */
export function cellR(s: string, n: number): string {
  return clip(s, n).padStart(n)
}

/** collapse whitespace/newlines into one line */
export function oneLine(s: string | undefined): string {
  return String(s ?? "").replace(/\s+/g, " ").trim()
}

/** word-wrap text to a column width, preserving explicit newlines */
export function wrapWords(text: string | undefined, width: number): string[] {
  const w = Math.max(8, width | 0)
  const out: string[] = []
  for (const raw of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/\t/g, "  ")
    if (line.length <= w) {
      out.push(line)
      continue
    }
    let cur = ""
    for (const word of line.split(" ")) {
      if (word.length > w) {
        if (cur) out.push(cur)
        cur = ""
        for (let i = 0; i < word.length; i += w) out.push(word.slice(i, i + w))
        continue
      }
      if (!cur) cur = word
      else if (cur.length + 1 + word.length <= w) cur += " " + word
      else {
        out.push(cur)
        cur = word
      }
    }
    if (cur) out.push(cur)
  }
  return out
}
