import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import type { Logger } from "../../logging/index.ts"

export const PI_SUBAGENT_PROFILES = {
  general: {
    name: "general",
    description: "General-purpose subagent",
    systemPrompt:
      "You are a general-purpose coding subagent. Complete the delegated task independently. Return concise findings and clearly identify any files changed.",
  },
  explore: {
    name: "explore",
    description: "Read-only codebase exploration subagent",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt:
      "You are a read-only exploration subagent. Inspect the codebase thoroughly, cite concrete file paths, and return compressed findings. Do not modify files.",
  },
  plan: {
    name: "plan",
    description: "Read-only implementation planning subagent",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt:
      "You are a read-only planning subagent. Investigate the relevant code first, then return a concrete implementation plan with file paths and risks. Do not modify files.",
  },
  review: {
    name: "review",
    description: "Read-only code review subagent",
    tools: ["read", "grep", "find", "ls", "bash"],
    systemPrompt:
      "You are a code-review subagent. Inspect the implementation and tests, prioritize correctness defects, and return actionable findings with file paths. Do not modify files.",
  },
} as const

const PI_TASK_PROFILES = Object.fromEntries(
  Object.entries(PI_SUBAGENT_PROFILES).map(([name, profile]) => [
    name,
    { tools: "tools" in profile ? profile.tools : undefined, prompt: profile.systemPrompt },
  ]),
)

/*
 * This extension is materialized next to the adapter database and explicitly
 * loaded by every main Pi RPC process. Keeping it out of Pi's auto-discovered
 * extensions directory prevents delegated child processes from recursively
 * acquiring the task tool.
 */
const TASK_EXTENSION_SOURCE = String.raw`
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const interactionPrefix = "__OPENCODE_ADAPTOR_PI_INTERACTION__ ";
const subtaskEventKey = "__opencode_adaptor_subtask_event";
const verboseInteractions = process.env.OPENCODE_ADAPTOR_VERBOSE === "1";

function logInteraction(direction, stream, metadata, payload) {
  if (!verboseInteractions) return;
  process.stderr.write(interactionPrefix + JSON.stringify({ direction, stream, metadata, payload }) + "\n");
}

const TaskParameters = Type.Object({
  description: Type.String({ description: "Short description shown in the parent conversation" }),
  prompt: Type.String({ description: "Complete, self-contained task for the delegated agent" }),
  subagent_type: Type.String({
    description: "Agent profile: general, explore, plan, or review",
    default: "general",
  }),
});

const profiles = ${JSON.stringify(PI_TASK_PROFILES)};

function normalizedParams(value) {
  const input = value && typeof value === "object" ? value : {};
  const prompt = typeof input.prompt === "string" ? input.prompt : typeof input.task === "string" ? input.task : "";
  const requested = typeof input.subagent_type === "string"
    ? input.subagent_type
    : typeof input.agent === "string"
      ? input.agent
      : "general";
  const subagent_type = Object.prototype.hasOwnProperty.call(profiles, requested) ? requested : "general";
  const description = typeof input.description === "string" && input.description.trim()
    ? input.description
    : prompt.slice(0, 80) || "Delegated task";
  return { description, prompt, subagent_type };
}

function finalAssistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function compactChildEvent(event) {
  if (!event || typeof event !== "object" || typeof event.type !== "string") return undefined;
  if (event.type === "message_update") {
    return { type: event.type, assistantMessageEvent: event.assistantMessageEvent };
  }
  if (event.type === "message_end" || event.type === "message_start") {
    return { type: event.type, message: event.message };
  }
  if (event.type === "agent_end") {
    const messages = Array.isArray(event.messages)
      ? event.messages.filter((message) => message && message.role === "assistant").slice(-1)
      : [];
    return { type: event.type, messages, willRetry: event.willRetry };
  }
  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end" ||
    event.type === "auto_retry_start" ||
    event.type === "auto_retry_end" ||
    event.type === "agent_start" ||
    event.type === "agent_settled" ||
    event.type === "extension_error"
  ) {
    return event;
  }
  return undefined;
}

function piInvocation(args) {
  const executable = process.execPath;
  const executableName = path.basename(executable).toLowerCase();
  const genericRuntime = /^(node|bun)(\.exe)?$/.test(executableName);
  const script = process.argv[1];
  if (genericRuntime && script && !script.startsWith("/$bunfs/")) {
    return { command: executable, args: [script, ...args] };
  }
  return { command: executable, args };
}

async function runTask(params, signal, onUpdate, ctx) {
  const profile = profiles[params.subagent_type] || profiles.general;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pi-task-"));
  const promptFile = path.join(tempDir, "system.md");
  fs.writeFileSync(promptFile, profile.prompt, { encoding: "utf8", mode: 0o600 });

  const args = ["--mode", "json", "--no-session", "--no-extensions", "-p"];
  if (ctx.model && typeof ctx.model.provider === "string") args.push("--provider", ctx.model.provider);
  if (ctx.model && typeof ctx.model.id === "string") args.push("--model", ctx.model.id);
  if (profile.tools && profile.tools.length > 0) args.push("--tools", profile.tools.join(","));
  args.push("--append-system-prompt", promptFile, "Task: " + params.prompt);

  const invocation = piInvocation(args);
  logInteraction(
    "out",
    "argv",
    { subprocess: "model-task", mode: "json", agent: params.subagent_type },
    {
      command: invocation.command,
      args: invocation.args,
      cwd: ctx.cwd,
      systemPrompt: profile.prompt,
      task: params.prompt,
    },
  );
  const messages = [];
  let stderr = "";
  let buffer = "";
  let aborted = false;

  try {
    const exitCode = await new Promise((resolve) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: ctx.cwd,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const processLine = (line) => {
        if (!line.trim()) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          logInteraction(
            "in",
            "stdout",
            { subprocess: "model-task", mode: "json", agent: params.subagent_type, invalid: true },
            line,
          );
          return;
        }
        logInteraction(
          "in",
          "stdout",
          { subprocess: "model-task", mode: "json", agent: params.subagent_type, type: event.type },
          event,
        );
        const childEvent = compactChildEvent(event);
        if (childEvent && onUpdate) {
          const output = finalAssistantText(messages);
          onUpdate({
            content: [{ type: "text", text: output }],
            details: {
              mode: "single",
              agent: params.subagent_type,
              status: "running",
              description: params.description,
              [subtaskEventKey]: childEvent,
            },
          });
        }
        if (event.type !== "message_end" || !event.message) return;
        messages.push(event.message);
      };

      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      child.stderr.on("data", (chunk) => {
        logInteraction(
          "in",
          "stderr",
          { subprocess: "model-task", mode: "json", agent: params.subagent_type },
          chunk.toString(),
        );
        if (stderr.length < 1024 * 1024) stderr += chunk.toString();
      });
      child.on("error", (error) => {
        stderr += "\n" + error.message;
        resolve(1);
      });
      child.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code == null ? 1 : code);
      });

      const abort = () => {
        aborted = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000).unref();
      };
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
    });

    const output = finalAssistantText(messages);
    const assistant = [...messages].reverse().find((message) => message && message.role === "assistant");
    const failed = aborted || exitCode !== 0 || assistant?.stopReason === "error" || assistant?.stopReason === "aborted";
    const fallback = aborted
      ? "Delegated task was aborted."
      : stderr.trim() || "Delegated task completed without a text response.";
    return {
      content: [{ type: "text", text: output || fallback }],
      details: {
        mode: "single",
        agent: params.subagent_type,
        status: failed ? (aborted ? "aborted" : "failed") : "completed",
        description: params.description,
        exitCode,
        stopReason: assistant?.stopReason,
        usage: assistant?.usage,
      },
      isError: failed,
    };
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
    try { fs.rmdirSync(tempDir); } catch {}
  }
}

export default function opencodeTaskExtension(pi) {
  pi.registerTool({
    name: "task",
    label: "Task",
    description: [
      "Delegate a self-contained task to an isolated Pi subagent.",
      "Use explore for codebase research, plan for implementation planning, review for code review, and general for implementation or mixed work.",
      "Independent task calls may run in parallel. The parent must use the returned result before answering.",
    ].join(" "),
    promptSnippet: "Delegate work to an isolated Pi subagent (general, explore, plan, or review)",
    promptGuidelines: [
      "When the user requests a subagent, subtask, delegation, or explicitly asks to call task, you MUST call task and MUST NOT perform the delegated work directly.",
      "Never claim that subagents are unavailable: the task tool is the supported subagent mechanism.",
      "Use task when independent exploration or work can be delegated.",
      "Give the subagent a complete prompt because it cannot see the parent conversation.",
    ],
    parameters: TaskParameters,
    prepareArguments: normalizedParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => runTask(params, signal, onUpdate, ctx),
  });
}
`.trimStart()

/*
 * Pi's official plan-mode reference is an example extension. This headless
 * variant keeps its core guarantees while OpenCode owns agent switching.
 */
const PLAN_EXTENSION_SOURCE = String.raw`
const disabledTools = new Set(["edit", "write"]);
const destructive = [
  /\brm(dir)?\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
  /\bchmod\b/i, /\bchown\b/i, /\bln\b/i, /\btee\b/i, /\btruncate\b/i,
  /(^|[^<])>(?!>)/, />>/,
  /\b(npm|pnpm|yarn|pip|apt|apt-get|brew)\s+(install|uninstall|remove|add|update|upgrade|ci)\b/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)\b/i,
  /\b(sudo|kill|pkill|killall|reboot|shutdown)\b/i,
];
const safe = [
  /^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|cal|uptime|ps|top|htop|free|jq|rg|fd|bat|eza)\b/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)/i,
  /^\s*(npm|yarn|pnpm)\s+(list|ls|view|info|search|outdated|audit|why)\b/i,
  /^\s*(node|python|bun)\s+--version\b/i,
  /^\s*sed\s+-n\b/i,
  /^\s*awk\b/i,
  /^\s*curl\b/i,
  /^\s*wget\s+-O\s*-\b/i,
];

function isSafeCommand(command) {
  return !destructive.some((pattern) => pattern.test(command)) && safe.some((pattern) => pattern.test(command));
}

export default function opencodePlanMode(pi) {
  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async () => {
    if (pi.getFlag("plan") !== true) return;
    pi.setActiveTools(pi.getActiveTools().filter((name) => !disabledTools.has(name)));
  });

  pi.on("tool_call", async (event) => {
    if (pi.getFlag("plan") !== true) return;
    if (disabledTools.has(event.toolName)) {
      return { block: true, reason: "Plan mode is read-only. Switch to the build agent before editing files." };
    }
    if (
      event.toolName === "task" &&
      !["explore", "plan"].includes(String(event.input?.subagent_type ?? event.input?.agent ?? ""))
    ) {
      return {
        block: true,
        reason: "Plan mode only allows the read-only explore and plan subagents.",
      };
    }
    if (event.toolName === "bash" && !isSafeCommand(String(event.input?.command ?? ""))) {
      return {
        block: true,
        reason: "Plan mode blocked a non-read-only shell command. Switch to the build agent before making changes.",
      };
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (pi.getFlag("plan") !== true) return;
    // Apply plan-mode instructions as a per-turn system-prompt override rather
    // than a persistent custom message. A 'message' returned here is persisted
    // into the Pi session file (as a custom_message entry) and replayed to the
    // LLM on every subsequent turn. Switching away from the plan agent reuses
    // the same Pi session file, so those persisted "[PLAN MODE ACTIVE]"
    // messages would keep telling the model it is still in plan mode even
    // after the user switches to the normal agent without a system prompt. A
    // 'systemPrompt' override applies only to the current turn and is never
    // stored in the session file, so it disappears cleanly on agent switch.
    const planInstructions = [
      "[PLAN MODE ACTIVE]",
      "You are in a read-only exploration mode for safe code analysis.",
      "Inspect the relevant code before proposing changes.",
      "Do not edit files or run commands that mutate the workspace.",
      "Return a concrete numbered plan with file paths, validation steps, and risks.",
    ].join("\n");
    return {
      systemPrompt: event.systemPrompt + "\n\n" + planInstructions,
    };
  });
}
`.trimStart()

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function taskExtensionPath(agentDir: string): string {
  return join(agentDir, "opencode-adaptor-runtime", "task.ts")
}

export function planExtensionPath(agentDir: string): string {
  return join(agentDir, "opencode-adaptor-runtime", "plan-mode.ts")
}

export function syncPiRuntimeAssets(agentDir: string, logger: Logger): boolean {
  const assets = [
    { path: taskExtensionPath(agentDir), source: TASK_EXTENSION_SOURCE },
    { path: planExtensionPath(agentDir), source: PLAN_EXTENSION_SOURCE },
  ]
  let changed = false
  for (const asset of assets) {
    const next = asset.source.endsWith("\n") ? asset.source : `${asset.source}\n`
    const previous = existsSync(asset.path) ? readFileSync(asset.path, "utf8") : undefined
    if (previous === next) continue
    writeAtomic(asset.path, next)
    logger.info("Synchronized Pi runtime extension", { path: asset.path })
    changed = true
  }
  return changed
}
