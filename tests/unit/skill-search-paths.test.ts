import { describe, expect, it } from "vitest"
import { resolveSkillSearchPaths } from "../../src/skills/search-paths.js"

describe("resolveSkillSearchPaths", () => {
  it("prefers skillTentacle.searchPaths while keeping legacy skill paths", () => {
    const paths = resolveSkillSearchPaths({
      skills: { paths: ["/legacy/skills", "/shared/skills"] },
      skillTentacle: { searchPaths: ["/tentacles", "/shared/skills"] },
    } as any)

    expect(paths).toEqual(["/tentacles", "/shared/skills", "/legacy/skills"])
  })
})
