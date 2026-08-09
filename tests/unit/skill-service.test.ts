import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Logger } from "../../src/logging/index.ts"
import { CommandNotFoundError, CommandService, expandCommandTemplate } from "../../src/skill/command-service.ts"
import { SkillService } from "../../src/skill/skill-service.ts"

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "opencode-adaptor-skills-"))
  temporaryDirectories.push(directory)
  return directory
}

function writeSkill(
  root: string,
  directoryName: string,
  input: { name?: string; description?: string; body?: string; disableModelInvocation?: boolean },
): string {
  const directory = join(root, directoryName)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "SKILL.md")
  const frontmatter = [
    "---",
    ...(input.name ? [`name: ${input.name}`] : []),
    ...(input.description ? [`description: ${input.description}`] : []),
    ...(input.disableModelInvocation ? ["disable-model-invocation: true"] : []),
    "---",
  ]
  writeFileSync(path, `${frontmatter.join("\n")}\n${input.body ?? "Follow the Skill instructions."}\n`)
  return path
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("SkillService", () => {
  test("merges Pi global and project Skills with deterministic project precedence", async () => {
    const root = temporaryDirectory()
    const home = join(root, "home")
    const project = join(root, "project")
    const globalSkills = join(home, ".pi", "agent", "skills")
    const projectSkills = join(project, ".pi", "skills")
    writeSkill(globalSkills, "review", { name: "review", description: "Global review", body: "global body" })
    const winner = writeSkill(projectSkills, "review", {
      name: "review",
      description: "Project review",
      body: "project body",
    })
    writeSkill(globalSkills, "manual-only", {
      name: "manual-only",
      description: "Manual only",
      disableModelInvocation: true,
    })
    writeSkill(projectSkills, "invalid", { name: "invalid", body: "missing description" })

    const service = new SkillService(new Logger(), {
      homeDirectory: home,
      xdgConfigHome: join(home, ".config"),
      directories: [
        { scope: "user", directory: () => globalSkills },
        { scope: "project", directory: () => projectSkills },
      ],
    })
    const snapshot = await service.snapshot(project)

    expect(snapshot.directory).toBe(project)
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["manual-only", "review"])
    expect(snapshot.skills.find((skill) => skill.name === "review")).toMatchObject({
      description: "Project review",
      content: "project body",
      location: winner,
      slash: true,
    })
    expect(snapshot.skills.find((skill) => skill.name === "manual-only")?.disableModelInvocation).toBe(true)
  })

  test("changes the atomic revision when a Skill attachment changes", async () => {
    const root = temporaryDirectory()
    const project = join(root, "project")
    const skills = join(project, ".pi", "skills")
    const manifest = writeSkill(skills, "review", { description: "Review code" })
    const attachment = join(skills, "review", "checklist.txt")
    writeFileSync(attachment, "first")
    const service = new SkillService(new Logger(), {
      homeDirectory: join(root, "home"),
      directories: [{ scope: "project", directory: () => skills }],
    })

    const first = await service.snapshot(project)
    writeFileSync(attachment, "second")
    const second = await service.snapshot(project)

    expect(first.skills[0]?.location).toBe(manifest)
    expect(first.revision).not.toBe(second.revision)
    expect(second.skills[0]?.files).toContain(attachment)
  })
})

describe("CommandService", () => {
  test("lists Skills as slash commands and freezes expanded content", async () => {
    const root = temporaryDirectory()
    const project = join(root, "project")
    const skills = join(project, ".pi", "skills")
    writeSkill(skills, "review", {
      name: "review",
      description: "Review code",
      body: "Review $1 with $2 and $ARGUMENTS.",
    })
    const skillService = new SkillService(new Logger(), {
      homeDirectory: join(root, "home"),
      directories: [{ scope: "project", directory: () => skills }],
    })
    const commands = new CommandService(skillService)

    expect((await commands.list(project)).map((command) => command.name)).toContain("review")
    const resolved = await commands.require(project, "review", '"src/app.ts" strict extra')
    expect(resolved.source).toBe("skill")
    expect(resolved.template).toContain("Review src/app.ts with strict extra")
    expect(resolved.template).toContain('and "src/app.ts" strict extra.')
    expect(resolved.template).toContain(`Skill base directory: ${join(skills, "review")}`)
  })

  test("excludes reserved command names from Skills and rejects reserved or unknown names", async () => {
    const root = temporaryDirectory()
    const project = join(root, "project")
    const skills = join(project, ".pi", "skills")
    writeSkill(skills, "init", { name: "init", description: "Reserved init" })
    writeSkill(skills, "compact", { name: "compact", description: "Reserved compact" })
    const commands = new CommandService(
      new SkillService(new Logger(), {
        homeDirectory: join(root, "home"),
        directories: [{ scope: "project", directory: () => skills }],
      }),
    )

    const listed = await commands.list(project)
    expect(listed.some((command) => command.name === "init")).toBe(false)
    expect(listed.some((command) => command.name === "compact")).toBe(false)
    await expect(commands.require(project, "init", "")).rejects.toBeInstanceOf(CommandNotFoundError)
    await expect(commands.require(project, "compact", "")).rejects.toBeInstanceOf(CommandNotFoundError)
    await expect(commands.require(project, "missing", "")).rejects.toBeInstanceOf(CommandNotFoundError)
  })

  test("appends arguments when a template has no placeholders", () => {
    expect(expandCommandTemplate("Review this", "src/app.ts")).toBe("Review this\n\nsrc/app.ts")
  })
})
