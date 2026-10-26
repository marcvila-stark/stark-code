export type PageField = {
  name: string;
  label: string;
  description: string;
  type: "string" | "number" | "integer" | "boolean";
  required: boolean;
  choices?: readonly string[];
};

export function pageRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function pageFieldLabel(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

/** Use the authenticated server's schema; never guess arguments for a read tool. */
export function publishedPageFields(schema: Record<string, unknown>): PageField[] | null {
  if (schema.type !== "object" || schema.oneOf || schema.anyOf || schema.allOf) return null;
  const properties = pageRecord(schema.properties) ?? {};
  if (Object.keys(properties).length > 20) return null;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const result: PageField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    let field = pageRecord(raw);
    // Python MCP servers commonly express optional scalar fields as a scalar/null union.
    const alternatives = field?.anyOf ?? field?.oneOf;
    if (field && Array.isArray(alternatives)) {
      const concrete = alternatives.map(pageRecord).filter((item) => item?.type !== "null");
      if (concrete.length === 1 && concrete[0] && alternatives.length === 2) {
        const { anyOf: _anyOf, oneOf: _oneOf, ...base } = field;
        field = { ...base, ...concrete[0] };
      }
    }
    if (field && Array.isArray(field.type)) {
      const concrete = field.type.filter((item) => item !== "null");
      if (concrete.length === 1) field = { ...field, type: concrete[0] };
    }
    if (!field || !["string", "number", "integer", "boolean"].includes(String(field.type))) {
      if (required.has(name)) return null;
      continue;
    }
    if (field.oneOf || field.anyOf || field.allOf || field.const !== undefined) {
      if (required.has(name)) return null;
      continue;
    }
    result.push({
      name,
      label: typeof field.title === "string" ? field.title : pageFieldLabel(name),
      description: typeof field.description === "string" ? field.description.slice(0, 400) : "",
      type: field.type as PageField["type"],
      required: required.has(name),
      ...(Array.isArray(field.enum) && field.enum.every((value) => typeof value === "string")
        ? { choices: field.enum as string[] }
        : {}),
    });
  }
  return [...required].every((name) => result.some((field) => field.name === name)) ? result : null;
}

export function publishedPageArguments(
  fields: readonly PageField[],
  values: Record<string, string>,
): Record<string, string | number | boolean> {
  const args: Record<string, string | number | boolean> = {};
  for (const field of fields) {
    const value = values[field.name] ?? "";
    if (!value.trim()) {
      if (field.required) throw new Error(`Enter ${field.label.toLowerCase()}.`);
      continue;
    }
    if (field.choices && !field.choices.includes(value))
      throw new Error(`Choose ${field.label.toLowerCase()} from the list.`);
    if (field.type === "boolean") {
      if (value !== "true" && value !== "false")
        throw new Error(`Choose ${field.label.toLowerCase()}.`);
      args[field.name] = value === "true";
    } else if (field.type === "number" || field.type === "integer") {
      const number = Number(value);
      if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number)))
        throw new Error(`Enter a valid ${field.label.toLowerCase()}.`);
      args[field.name] = number;
    } else args[field.name] = value;
  }
  return args;
}

export function decodePublishedPageText(text: string): unknown {
  if (/^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      // A normal page may start with Markdown brackets.
    }
  }
  return text;
}
