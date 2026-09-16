// Minimal JSON-Schema validator for agent structured output.
// Supports the subset workflow scripts use: type (object/array/string/number/boolean),
// properties, required, items, enum, additionalProperties.

export class SchemaError extends Error {}

export function validateSchema(value: unknown, schema: unknown, path = "$"): void {
  if (!schema || typeof schema !== "object") return
  const s = schema as any
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type]
    if (!types.some((t: string) => matchesType(value, t)))
      throw new SchemaError(`${path}: expected type ${types.join("|")}, got ${typeName(value)}`)
  }
  if (s.enum && !s.enum.includes(value))
    throw new SchemaError(`${path}: value not in enum [${s.enum.join(", ")}]`)
  if (s.type === "object" || (typeof value === "object" && value !== null && !Array.isArray(value) && s.properties)) {
    const obj = value as Record<string, unknown>
    for (const req of s.required ?? []) {
      if (!(req in obj)) throw new SchemaError(`${path}: missing required property "${req}"`)
    }
    for (const [key, sub] of Object.entries<any>(s.properties ?? {})) {
      if (key in obj) validateSchema(obj[key], sub, `${path}.${key}`)
    }
    if (s.additionalProperties === false && s.required) {
      const allowed = new Set(s.required)
      for (const k of Object.keys(obj)) if (!allowed.has(k)) {
        // only reject when properties are also defined, to stay permissive
        if (s.properties) throw new SchemaError(`${path}.${k}: additional property not allowed`)
      }
    }
  }
  if (s.type === "array" || Array.isArray(value)) {
    if (Array.isArray(value) && s.items) {
      value.forEach((v, i) => validateSchema(v, s.items, `${path}[${i}]`))
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
    case "array":
      return Array.isArray(value)
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number"
    case "integer":
      return Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    default:
      return true
  }
}
function typeName(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  return typeof v
}

/** Extract the JSON value from a model's text response: last code block or last object/array literal. */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = text.trim()
  try {
    return { ok: true, value: JSON.parse(t) }
  } catch {}
  // fenced block
  const fences = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  for (let i = fences.length - 1; i >= 0; i--) {
    const inner = fences[i][1].trim()
    try {
      return { ok: true, value: JSON.parse(inner) }
    } catch {}
  }
  // last balanced object
  for (const open of ["{", "["]) {
    const close = open === "{" ? "}" : "]"
    const start = t.lastIndexOf(open)
    const end = t.lastIndexOf(close)
    if (start !== -1 && end > start) {
      try {
        return { ok: true, value: JSON.parse(t.slice(start, end + 1)) }
      } catch {}
    }
  }
  return { ok: false, error: "no JSON object found in response" }
}
