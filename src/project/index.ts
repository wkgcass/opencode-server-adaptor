import { createHash } from "node:crypto"
import { resolve } from "node:path"

/** Stable project identity shared by project and session responses. */
export function projectIDForDirectory(directory: string): string {
  return createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 24)
}
