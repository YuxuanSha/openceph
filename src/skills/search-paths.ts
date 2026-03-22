import type { OpenCephConfig } from "../config/config-schema.js"

export function resolveSkillSearchPaths(
  config: Pick<OpenCephConfig, "skills" | "skillTentacle">,
): string[] {
  const ordered = [
    ...(config.skillTentacle?.searchPaths ?? []),
    ...(config.skills?.paths ?? []),
  ]

  return [...new Set(ordered.filter(Boolean))]
}
