// Vendored from @earendil-works/pi-coding-agent
// Source: packages/coding-agent/src/utils/frontmatter.ts
// Commit: 7df73a00c6cf85c000bf1ce1594c9284067a92f0
// License: MIT

import { parse } from "yaml"

type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T
	body: string
}

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	const normalized = normalizeNewlines(content)

	if (!normalized.startsWith("---")) {
		return { yamlString: null, body: normalized }
	}

	const endIndex = normalized.indexOf("\n---", 3)
	if (endIndex === -1) {
		return { yamlString: null, body: normalized }
	}

	return {
		yamlString: normalized.slice(4, endIndex),
		body: normalized.slice(endIndex + 4).trim(),
	}
}

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yamlString, body } = extractFrontmatter(content)
	if (!yamlString) {
		return { frontmatter: {} as T, body }
	}
	const parsed = parse(yamlString)
	return { frontmatter: (parsed ?? {}) as T, body }
}

export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body
