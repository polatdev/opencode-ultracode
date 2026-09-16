// Workflow script parsing and sandboxed execution context.
//
// Scripts are plain JavaScript (NOT TypeScript) that must begin with a pure
// literal `export const meta = {...}`. The body runs in an async sandbox with
// the orchestration primitives as parameters. Deterministic-safety:
// Date.now()/Math.random()/argless new Date() throw, and dangerous globals
// (process, require, fetch, Bun, ...) are shadowed so they resolve to throwers.
// This is a determinism sandbox for resume, NOT a security boundary.

import type { PhaseDef } from "../shared/state.ts"

export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: PhaseDef[]
}

export interface ParsedScript {
  meta: WorkflowMeta
  body: string
}

const META_RE = /export\s+const\s+meta\s*=\s*/

export function parseScript(script: string): ParsedScript {
  const m = script.match(META_RE)
  if (!m || m.index === undefined) throw new Error("Workflow script must start with `export const meta = { ... }`")
  const start = script.indexOf("{", m.index + m[0].length)
  if (start === -1) throw new Error("Could not find meta object literal")
  const end = findBalanced(script, start)
  const literal = script.slice(start, end + 1)
  // meta must be a pure literal; evaluating an object literal with new Function
  // is safe as long as it contains no expressions — we lint that first.
  if (/[;,\n]\s*function\b|\bnew\s+|\bif\s*\(|\bwhile\s*\(|=>/.test(literal))
    throw new Error("meta must be a pure object literal (no functions, calls, or arrow functions)")
  let meta: WorkflowMeta
  try {
    meta = new Function(`"use strict"; return (${literal})`)() as WorkflowMeta
  } catch (e: any) {
    throw new Error(`Invalid meta literal: ${e?.message ?? e}`)
  }
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object")
  if (!meta.name || typeof meta.name !== "string") throw new Error("meta.name is required")
  if (!meta.description || typeof meta.description !== "string")
    throw new Error("meta.description is required (one line, shown in the approval dialog)")
  for (const p of meta.phases ?? []) {
    if (!p.title) throw new Error("each meta.phases entry needs a title")
  }
  const body = (script.slice(0, start) + " ".repeat(end - start + 1) + script.slice(end + 1)).replace(META_RE, "")
  return { meta, body }
}

function findBalanced(s: string, openIdx: number): number {
  let depth = 0
  let inStr: string | null = null
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (c === "\\") i++
      else if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === "`") inStr = c
    else if (c === "{" || c === "[" || c === "(") depth++
    else if (c === "}" || c === "]" || c === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error("Unbalanced meta literal")
}

// --- sandbox ----------------------------------------------------------------

export interface Primitives {
  agent: (prompt: string, opts?: AgentOpts) => Promise<any>
  parallel: (thunks: Array<() => Promise<any>>) => Promise<any[]>
  pipeline: <T, R>(items: T[], ...stages: Array<(prev: any, item: T, index: number) => Promise<R> | R>) => Promise<any[]>
  phase: (title: string) => void
  log: (message: string) => void
  args: any
  budget: Budget
}

export interface AgentOpts {
  label?: string
  phase?: string
  schema?: object
  model?: string
  effort?: string
  isolation?: string
  agentType?: string
}

export interface Budget {
  total: number | null
  spent(): number
  remaining(): number
}

function throwing(name: string): any {
  const f: any = () => {
    throw new Error(`Access to global "${name}" is not available in workflow scripts; use log() for output`)
  }
  return new Proxy(f, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive || prop === "then") return undefined
      throw new Error(`Access to "${name}.${String(prop)}" is not available in workflow scripts`)
    },
    apply: () => {
      throw new Error(`Access to global "${name}" is not available in workflow scripts`)
    },
  })
}

/** Deterministic Date: no-arg new Date() and Date.now() throw. */
function makeSafeDate(): any {
  class SafeDate {
    getTime = () => 0
    valueOf = () => 0
    toString = () => ""
    toISOString = () => ""
    constructor(...args: any[]) {
      if (args.length === 0)
        throw new Error("new Date() without arguments is not available in workflow scripts (breaks resume); pass a timestamp via args")
      // delegate to the real Date via a hidden reference
      const D = makeSafeDate as any;
      const real = new D.__impl(...args)
      for (const k of Object.keys(real)) (this as any)[k] = (real as any)[k]
      this.getTime = real.getTime.bind(real)
      this.valueOf = real.valueOf.bind(real)
      this.toString = real.toString.bind(real)
      this.toISOString = real.toISOString.bind(real)
    }
    static now() {
      throw new Error("Date.now() is not available in workflow scripts (breaks resume); pass a timestamp via args")
    }
    static parse(...a: any[]) {
      const D = makeSafeDate as any
      return D.__impl.parse(...a)
    }
    static UTC(...a: any[]) {
      const D = makeSafeDate as any
      return D.__impl.UTC(...a)
    }
  }
  ;(makeSafeDate as any).__impl = Date
  return SafeDate
}

/** Math minus random. */
function makeSafeMath(): any {
  const real = Object.create(Math)
  return new Proxy(real, {
    get(t, prop) {
      if (prop === "random")
        return () => {
          throw new Error("Math.random() is not available in workflow scripts (breaks resume); vary prompts/labels by index")
        }
      const v = (t as any)[prop]
      return typeof v === "function" ? v.bind(t) : v
    },
  })
}

const SHADOWED = [
  "require",
  "process",
  "Bun",
  "fetch",
  "WebSocket",
  "EventSource",
  "crypto",
  "globalThis",
  "self",
  "window",
  "global",
  "Buffer",
  "child_process",
  "fs",
  "os",
  "module",
  "exports",
  "__dirname",
  "__filename",
] as const

/**
 * Build the sandboxed script function. The body runs in an async IIFE with the
 * primitives in scope; dangerous globals are shadowed by the proxy throwers.
 */
export function buildScriptFunction(prims: Primitives, body: string): () => Promise<any> {
  const safeDate = makeSafeDate()
  const safeMath = makeSafeMath()
  const shadows = SHADOWED.map((n) => throwing(n))
  const fn = new Function(
    "agent",
    "parallel",
    "pipeline",
    "phase",
    "log",
    "args",
    "budget",
    "Date",
    "Math",
    "console",
    ...SHADOWED,
    `"use strict"; return (async () => {\n${body}\n})()`,
  )
  const consoleShadow = new Proxy({} as Record<string | symbol, any>, {
    get() {
      return (..._a: any[]) => {
        throw new Error("console is not available in workflow scripts; use log()")
      }
    },
  })
  return () =>
    fn(prims.agent, prims.parallel, prims.pipeline, prims.phase, prims.log, prims.args, prims.budget, safeDate, safeMath, consoleShadow, ...shadows)
}
