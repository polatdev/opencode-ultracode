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
  // meta is parsed, never evaluated: the parser accepts ONLY literal syntax, so
  // purity is guaranteed by construction and every rejection points at an offset.
  const { value, end } = parseMetaLiteral(script, start)
  const meta = value as WorkflowMeta
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("meta must be an object")
  if (!meta.name || typeof meta.name !== "string") throw new Error("meta.name is required")
  if (!meta.description || typeof meta.description !== "string")
    throw new Error("meta.description is required (one line, shown in the approval dialog)")
  for (const p of meta.phases ?? []) {
    if (!p.title) throw new Error("each meta.phases entry needs a title")
  }
  const body = (script.slice(0, start) + " ".repeat(end - start + 1) + script.slice(end + 1)).replace(META_RE, "")
  return { meta, body }
}

// --- meta literal parser ------------------------------------------------------
//
// A recursive-descent parser for the pure-literal subset meta is allowed to use:
// objects, arrays, quoted strings, numbers, true/false/null (trailing commas and
// comments permitted). Anything else — a call, an identifier reference, a template
// string, an operator — is a parse error with an exact position, instead of a
// regex that lets `description: f()` through and blows up later at eval time.

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y

export function parseMetaLiteral(src: string, start: number): { value: unknown; end: number } {
  let i = start

  const fail = (msg: string, at = i): never => {
    const line = src.slice(0, at).split("\n").length
    const col = at - (src.lastIndexOf("\n", at - 1) + 1) + 1
    const near = src.slice(at, at + 24).split("\n")[0]
    throw new Error(`meta must be a pure object literal — ${msg} at line ${line}:${col}${near ? ` near \`${near}\`` : ""}`)
  }

  const skip = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++
      if (src[i] === "/" && src[i + 1] === "/") {
        const nl = src.indexOf("\n", i)
        i = nl === -1 ? src.length : nl + 1
      } else if (src[i] === "/" && src[i + 1] === "*") {
        const close = src.indexOf("*/", i + 2)
        if (close === -1) fail("unterminated comment")
        i = close + 2
      } else return
    }
  }

  const parseString = (): string => {
    const quote = src[i]
    if (quote === "`") fail("template strings are not allowed (meta must be static)")
    i++
    let out = ""
    while (i < src.length) {
      const c = src[i]
      if (c === "\\") {
        const e = src[i + 1]
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" }
        if (e === "u") {
          const hex = src.slice(i + 2, i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid \\u escape")
          out += String.fromCharCode(parseInt(hex, 16))
          i += 6
        } else if (e === "x") {
          const hex = src.slice(i + 2, i + 4)
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail("invalid \\x escape")
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
        } else if (e === "\n") {
          i += 2
        } else {
          out += simple[e] ?? e
          i += 2
        }
        continue
      }
      if (c === quote) {
        i++
        return out
      }
      if (c === "\n") fail("unterminated string")
      out += c
      i++
    }
    return fail("unterminated string")
  }

  const parseValue = (): unknown => {
    skip()
    const c = src[i]
    if (c === undefined) return fail("unexpected end of meta literal")
    if (c === '"' || c === "'" || c === "`") return parseString()
    if (c === "{") return parseObject()
    if (c === "[") return parseArray()
    if (c === "-" || c === "+" || (c >= "0" && c <= "9")) {
      const num = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y
      num.lastIndex = i
      const m2 = num.exec(src)
      if (!m2 || m2.index !== i) return fail("invalid number")
      i += m2[0].length
      return Number(m2[0])
    }
    IDENT_RE.lastIndex = i
    const word = IDENT_RE.exec(src)
    if (word && word.index === i) {
      const w = word[0]
      if (w === "true" || w === "false" || w === "null" || w === "undefined") {
        i += w.length
        skip()
        if (src[i] === "(") return fail(`\`${w}\` is not callable here; meta values must be literals`, i)
        return w === "true" ? true : w === "false" ? false : null
      }
      return fail(`\`${w}\` is not a literal — meta values must be strings, numbers, booleans, null, arrays or objects`)
    }
    return fail("unexpected token")
  }

  const parseArray = (): unknown[] => {
    i++ // [
    const out: unknown[] = []
    for (;;) {
      skip()
      if (src[i] === "]") {
        i++
        return out
      }
      if (i >= src.length) return fail("unterminated array")
      out.push(parseValue())
      skip()
      if (src[i] === ",") {
        i++
        continue
      }
      if (src[i] === "]") {
        i++
        return out
      }
      return fail("expected `,` or `]`")
    }
  }

  const parseObject = (): Record<string, unknown> => {
    i++ // {
    const out: Record<string, unknown> = {}
    for (;;) {
      skip()
      if (src[i] === "}") {
        i++
        return out
      }
      if (i >= src.length) return fail("unterminated object")
      if (src[i] === "." || src[i] === "[") return fail("computed or spread keys are not allowed in meta")
      let key: string
      if (src[i] === '"' || src[i] === "'" || src[i] === "`") key = parseString()
      else {
        IDENT_RE.lastIndex = i
        const k = IDENT_RE.exec(src)
        if (!k || k.index !== i) return fail("expected a property name")
        key = k[0]
        i += key.length
      }
      skip()
      if (src[i] === "(") return fail(`\`${key}(...)\` is a method — meta must contain no functions`, i)
      if (src[i] !== ":") return fail(`expected \`:\` after property \`${key}\``)
      i++
      out[key] = parseValue()
      skip()
      if (src[i] === ",") {
        i++
        continue
      }
      if (src[i] === "}") {
        i++
        return out
      }
      return fail("expected `,` or `}`")
    }
  }

  skip()
  if (src[i] !== "{") fail("meta must be an object literal")
  const value = parseObject()
  return { value, end: i - 1 }
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
