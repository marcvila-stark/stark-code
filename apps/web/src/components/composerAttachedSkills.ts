import type { ServerProviderSkill } from "@starkfuture/contracts";

/** Keep the provider's prompt intact; only the editable view omits attached skills. */
export function splitAttachedSkills(value: string, skills: readonly ServerProviderSkill[]) {
  const attached: { skill: ServerProviderSkill; start: number; end: number }[] = [];
  let offset = 0;
  while (offset < value.length) {
    const match = /^([$\/])([A-Za-z0-9][A-Za-z0-9:_-]*)(\s+)/.exec(value.slice(offset));
    if (!match) break;
    const skill = skills.find((item) => item.name === match[2]);
    if (!skill) break;
    attached.push({ skill, start: offset, end: offset + match[0].length });
    offset += match[0].length;
  }
  return { attached, prefix: value.slice(0, offset), body: value.slice(offset), offset };
}

export function attachSkillAtStart(input: {
  value: string;
  start: number;
  end: number;
  reference: string;
}) {
  const body = input.value.slice(0, input.start) + input.value.slice(input.end);
  const prefix = `${input.reference.trim()} `;
  return { value: prefix + body, cursor: prefix.length + input.start };
}
