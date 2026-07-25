# Upstream Source: Pi Official Subagent Extension

This directory contains code copied from the Pi coding agent's official subagent
extension. The code is licensed under the MIT License (see end of file).

## Upstream Repository

- **Repository:** https://github.com/earendil-works/pi (or local path `../pi`)
- **Commit:** `7df73a00c6cf85c000bf1ce1594c9284067a92f0`
- **Date:** 2026-07-24 (Pi v0.82.0 cycle)

## Original File Paths

| This Project | Upstream Path |
|---|---|
| `agents.ts` | `packages/coding-agent/examples/extensions/subagent/agents.ts` |
| `runner.ts` | `packages/coding-agent/examples/extensions/subagent/index.ts` (core runner extracted) |
| `frontmatter.ts` | `packages/coding-agent/src/utils/frontmatter.ts` |
| `config.ts` | `packages/coding-agent/src/config.ts` (extracted `getAgentDir` + `CONFIG_DIR_NAME`) |

## Local Modifications

### `agents.ts`
- Replaced `import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent"` with local imports from `./config.ts` and `./frontmatter.ts`.
- Added `provider?: string` field to `AgentConfig` interface (for per-task provider selection).

### `runner.ts`
- Extracted core runner functions from `index.ts` (the extension's tool registration, TUI rendering, and parameter schemas were NOT copied — only the execution logic).
- `getPiInvocation()` replaced with `getPiInvocation(args, piExecutable?)` that accepts a configurable executable path instead of inspecting `process.argv`.
- Configured executable strings are parsed without a shell and support quoted paths, escaped whitespace, and empty quoted arguments.
- `writePromptToTempFile()` simplified to remove `withFileMutationQueue` dependency (unnecessary for unique temp dirs).
- Types `UsageStats`, `SingleResult`, `SubagentDetails` exported for adapter use.
- `runSingleAgent()` signature unchanged; `OnUpdateCallback` type exported.
- Added `runParallel()` and `runChain()` wrapper functions extracted from the extension's `execute()` method.
- `runSingleAgent()`: added `--provider` CLI arg when `agent.provider` is set (before `--model`).
- `RunnerOptions`: added environment and pre-spawn hooks so adaptor-owned Pi configuration can be materialized and passed to child processes.
- JSONL parsing, usage tracking, output extraction, and the upstream SIGTERM/SIGKILL abort lifecycle are retained.

### `frontmatter.ts`
- Verbatim copy. Uses `yaml` package (added as project dependency).

### `config.ts`
- Extracted `CONFIG_DIR_NAME` and `getAgentDir()` from `packages/coding-agent/src/config.ts`.
- Hardcoded `CONFIG_DIR_NAME = ".pi"` (matches upstream default).
- `getAgentDir()` respects `PI_CODING_AGENT_DIR` env var, defaults to `~/.pi/agent`.
- `expandTildePath()` vendored from upstream.

## How to Update from Upstream

1. `cd ../pi && git pull`
2. Record the new commit: `git -C ../pi rev-parse HEAD`
3. Compare the upstream files listed above with the copies in this directory.
4. Copy any changes, re-applying the local modifications listed above.
5. Run upstream compatibility tests: `bun test tests/unit/upstream-*.test.ts`
6. Update the commit hash in this file.
7. Run full test suite to verify no regressions.

## License

```
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
