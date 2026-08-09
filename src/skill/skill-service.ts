import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { parse } from "yaml"
import type { Logger } from "../logging/index.ts"

export interface SkillInfo {
  name: string
  description?: string
  slash: boolean
  location: string
  content: string
}

export interface ResolvedSkill extends SkillInfo {
  baseDirectory: string
  files: readonly string[]
  digest: string
  disableModelInvocation: boolean
}

export interface SkillCatalogSnapshot {
  revision: string
  directory: string
  skills: readonly ResolvedSkill[]
}

export interface SkillDirectoryRegistration {
  scope: "user" | "project" | "explicit" | "builtin"
  directory: (projectDirectory: string) => string
  priority?: number
}

export interface SkillServiceOptions {
  homeDirectory?: string
  xdgConfigHome?: string
  directories?: readonly SkillDirectoryRegistration[]
}

interface SkillRoot {
  path: string
  scope: SkillDirectoryRegistration["scope"]
  priority: number
}

interface ParsedFrontmatter {
  name?: unknown
  description?: unknown
  "disable-model-invocation"?: unknown
}

const SCOPE_PRIORITY: Record<SkillDirectoryRegistration["scope"], number> = {
  builtin: 0,
  user: 100,
  project: 200,
  explicit: 300,
}

export class SkillNotFoundError extends Error {
  readonly name = "SkillNotFoundError"

  constructor(
    readonly skillName: string,
    readonly available: readonly string[],
  ) {
    super(`Skill "${skillName}" not found. Available skills: ${available.join(", ") || "none"}`)
  }
}

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function splitFrontmatter(raw: string): { data: ParsedFrontmatter; content: string } {
  const normalized = raw.replace(/^\uFEFF/, "")
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized)
  if (!match) return { data: {}, content: normalized.trim() }
  const parsed = parse(match[1] ?? "")
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error("Skill frontmatter must be a YAML mapping")
  }
  return {
    data: (parsed ?? {}) as ParsedFrontmatter,
    content: normalized.slice(match[0].length).trim(),
  }
}

function validateName(name: string): string | undefined {
  if (name.length === 0 || name.length > 64) return "name must contain between 1 and 64 characters"
  if (!/^[a-z0-9-]+$/.test(name)) return "name must contain only lowercase letters, digits, and hyphens"
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return "name must not start or end with a hyphen or contain consecutive hyphens"
  }
  return undefined
}

function collectSkillFiles(baseDirectory: string): string[] {
  const files: string[] = []
  const seenDirectories = new Set<string>()
  const visit = (directory: string): void => {
    const canonicalDirectory = canonicalPath(directory)
    if (seenDirectories.has(canonicalDirectory)) return
    seenDirectories.add(canonicalDirectory)
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      const path = join(directory, entry.name)
      try {
        const stats = entry.isSymbolicLink() ? statSync(path) : undefined
        if (entry.isDirectory() || stats?.isDirectory()) visit(path)
        else if (entry.isFile() || stats?.isFile()) files.push(canonicalPath(path))
      } catch {
        // Ignore broken links and files that disappear during a scan.
      }
    }
  }
  visit(baseDirectory)
  return [...new Set(files)].sort()
}

function digestSkill(skill: Omit<ResolvedSkill, "digest">): string {
  const hash = createHash("sha256")
  hash.update(skill.name)
  hash.update("\0")
  hash.update(skill.description ?? "")
  hash.update("\0")
  hash.update(skill.location)
  hash.update("\0")
  hash.update(skill.content)
  hash.update("\0")
  hash.update(skill.disableModelInvocation ? "1" : "0")
  for (const file of skill.files) {
    hash.update("\0")
    hash.update(file)
    try {
      hash.update("\0")
      hash.update(readFileSync(file))
    } catch {
      hash.update("\0<unreadable>")
    }
  }
  return hash.digest("hex")
}

export class SkillService {
  private readonly logger: Logger
  private readonly roots: readonly SkillDirectoryRegistration[]
  private readonly homeDirectory: string
  private readonly xdgConfigHome: string

  constructor(logger: Logger, options?: SkillServiceOptions) {
    this.logger = logger
    this.homeDirectory = options?.homeDirectory ?? homedir()
    this.xdgConfigHome = options?.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? join(this.homeDirectory, ".config")
    this.roots = options?.directories ?? []
  }

  async list(directory: string): Promise<readonly SkillInfo[]> {
    return (await this.snapshot(directory)).skills.map(({ name, description, slash, location, content }) => ({
      name,
      description,
      slash,
      location,
      content,
    }))
  }

  async require(directory: string, name: string): Promise<ResolvedSkill> {
    const snapshot = await this.snapshot(directory)
    const skill = snapshot.skills.find((candidate) => candidate.name === name)
    if (skill) return skill
    throw new SkillNotFoundError(
      name,
      snapshot.skills.map((candidate) => candidate.name),
    )
  }

  async snapshot(directory: string): Promise<SkillCatalogSnapshot> {
    const projectDirectory = canonicalPath(directory)
    const roots = this.resolveRoots(projectDirectory)
    const winners = new Map<string, ResolvedSkill>()
    const seenFiles = new Set<string>()

    for (const root of roots) {
      for (const location of this.discover(root.path)) {
        if (seenFiles.has(location)) continue
        seenFiles.add(location)
        const skill = this.parseSkill(location)
        if (!skill) continue
        const previous = winners.get(skill.name)
        if (previous) {
          this.logger.warn("Duplicate Skill name; higher-priority path won", {
            name: skill.name,
            winner: skill.location,
            loser: previous.location,
          })
        }
        winners.set(skill.name, skill)
      }
    }

    const skills = [...winners.values()].sort((left, right) => left.name.localeCompare(right.name))
    const hash = createHash("sha256")
    hash.update(projectDirectory)
    for (const skill of skills) {
      hash.update("\0")
      hash.update(skill.name)
      hash.update("\0")
      hash.update(skill.digest)
    }
    return { revision: hash.digest("hex"), directory: projectDirectory, skills }
  }

  private resolveRoots(projectDirectory: string): SkillRoot[] {
    const defaults: SkillDirectoryRegistration[] = [
      { scope: "user", directory: () => join(this.xdgConfigHome, "opencode", "skill") },
      { scope: "user", directory: () => join(this.xdgConfigHome, "opencode", "skills") },
      { scope: "user", directory: () => join(this.homeDirectory, ".agents", "skills") },
      { scope: "user", directory: () => join(this.homeDirectory, ".claude", "skills") },
      { scope: "project", directory: (current) => join(current, ".opencode", "skill") },
      { scope: "project", directory: (current) => join(current, ".opencode", "skills") },
      { scope: "project", directory: (current) => join(current, ".agents", "skills") },
      { scope: "project", directory: (current) => join(current, ".claude", "skills") },
    ]
    return [...defaults, ...this.roots]
      .map((root) => ({
        path: canonicalPath(root.directory(projectDirectory)),
        scope: root.scope,
        priority: root.priority ?? SCOPE_PRIORITY[root.scope],
      }))
      .filter((root, index, all) => all.findIndex((candidate) => candidate.path === root.path) === index)
      .sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path))
  }

  private discover(root: string): string[] {
    if (!existsSync(root)) return []
    const matches: string[] = []
    const seenDirectories = new Set<string>()
    const visit = (directory: string, includeRootFiles: boolean): void => {
      const canonicalDirectory = canonicalPath(directory)
      if (seenDirectories.has(canonicalDirectory)) return
      seenDirectories.add(canonicalDirectory)
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
          left.name.localeCompare(right.name),
        )
      } catch (error) {
        this.logger.warn("Failed to scan Skill directory", {
          directory,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      const manifest = entries.find((entry) => entry.name === "SKILL.md")
      if (manifest) {
        const path = join(directory, manifest.name)
        try {
          if (manifest.isFile() || (manifest.isSymbolicLink() && statSync(path).isFile()))
            matches.push(canonicalPath(path))
        } catch {
          // Ignore a manifest that disappears during discovery.
        }
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue
        const path = join(directory, entry.name)
        try {
          const stats = entry.isSymbolicLink() ? statSync(path) : undefined
          if (entry.isDirectory() || stats?.isDirectory()) visit(path, false)
          else if (includeRootFiles && entry.name.endsWith(".md") && (entry.isFile() || stats?.isFile())) {
            matches.push(canonicalPath(path))
          }
        } catch {
          // Ignore broken links and directories that disappear during discovery.
        }
      }
    }
    visit(root, true)
    return [...new Set(matches)].sort()
  }

  private parseSkill(location: string): ResolvedSkill | undefined {
    try {
      const raw = readFileSync(location, "utf8")
      const { data, content } = splitFrontmatter(raw)
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : basename(dirname(location))
      const nameError = validateName(name)
      if (nameError) throw new Error(nameError)
      const description = typeof data.description === "string" ? data.description.trim() : ""
      if (!description) throw new Error("description is required")
      if (description.length > 1024) throw new Error("description exceeds 1024 characters")
      const baseDirectory = canonicalPath(dirname(location))
      const value = {
        name,
        description,
        slash: true,
        location: canonicalPath(location),
        content,
        baseDirectory,
        files: collectSkillFiles(baseDirectory),
        disableModelInvocation: data["disable-model-invocation"] === true,
      }
      return { ...value, digest: digestSkill(value) }
    } catch (error) {
      this.logger.warn("Failed to load Skill", {
        location,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }
}
