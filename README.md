# opencode-server-adaptor

`opencode-server-adaptor` 是一个兼容 OpenCode Server API 的 Agent 适配服务。它实现了 OpenCode Desktop
所需的 CLI、HTTP REST API 和 SSE 事件流，并将 OpenCode 的会话、消息、工具调用、权限确认和子智能体操作转换为
后端 Agent 的运行协议。

目前项目只接入了 Pi coding agent，但核心实现支持扩展其他 Agent 后端。架构设计、接口分层、生命周期、子智能体方案、
重启恢复约定、开发调优参数和测试规范见 [AGENTS.md](./AGENTS.md)。接口分层细节见
[INTERFACE.md](./INTERFACE.md)。

## 架构概览

服务按“协议映射 → 应用服务 → 后端接口 → 后端实现”分层。HTTP 路由只负责 OpenCode 字段、状态码和错误 envelope；
[`SessionService`](./src/session/session-service.ts) 统一会话用例，
[`AgentService`](./src/agents/agent-service.ts) 负责编排 Runtime、事件投影和子任务，
[`AgentAdapter`](./src/agents/agent-adapter.ts) / `AgentRuntime` 是后端扩展边界。SQLite 访问集中在 session、message、
permission 和 durable event 仓库中，路由与 Agent 编排不直接执行 SQL。Pi 的进程、RPC、事件转换和模型同步全部位于
[`src/agents/pi`](./src/agents/pi)；新增后端不应修改 OpenCode 会话主流程。更完整的依赖方向和生命周期约定见
[INTERFACE.md](./INTERFACE.md)。

## OpenCode 协议兼容

当前兼容目标为 OpenCode `1.18.7`。服务默认启用 v2 协议（接口位于 `/api/*`），可通过 `--api-version=v1`
切换为精简的 v1 配置与检查层。两种模式默认都挂载一个兼容层，提供当前OpenCode即使检测到v2 server却仍在使用的v1接口。
v1/v2 的完整接口清单和设计说明见 [AGENTS.md](./AGENTS.md)。

<details><summary>限制</summary>

## 限制

### API 协议兼容

项目优先兼容 v2 API，因为这是 OpenCode 面向后续长期维护的协议方向。但 OpenCode 的 v2 协议和 Desktop 实现仍在
迁移中，部分功能缺少 v2 支持，另一些功能即使在 v2 模式下仍依赖旧版协议。当前做了以下取舍和兼容：

- v2 模式下仍会提供一组 legacy 兼容功能，以保证 Desktop 的配置读取、会话删除和文件树可以正常工作。可以通过
  `--disable-v1-compatible` 关闭这些功能，但关闭后 Desktop 的文件树和部分操作可能不可用。
- legacy 文件功能只覆盖 Desktop 当前实际使用的文件树、文件读取和文件名查找。文件状态、全文搜索和符号搜索不可用；
  大文件不能直接读取，文件名查找也限制搜索深度和结果数量，并会忽略常见的隐藏目录、依赖目录和符号链接。
- 部分 Desktop 版本在 v2 模式下无法完成终端连接认证，表现为终端创建后无法连接。可以使用
  `--disable-pty-token-check` 兼容这些版本；该参数会削弱终端连接保护，只应在可信的本机环境中使用。
- Desktop 一旦把服务识别为 v2，就不会开放仅支持 v1 的自定义 provider/model 结构编辑。可以直接修改
  `providers.yaml`，或者用 `--api-version=v1` 启动服务完成配置；配置完成后必须以 v2 模式重启服务，并重启 OpenCode
  客户端，使其重新探测协议。v1 模式只是精简的配置与检查模式，不能用于正常对话和任务执行。v2 模式仍可查看
  provider/model，并可为已经存在的 provider 更新 API key。
- provider 认证目前只可靠支持 API key，不支持完整的第三方 OAuth 登录、token 交换和刷新流程。
- Skill 会从 Pi 原生的全局目录 `~/.pi/agent/skills` 和当前工程的 `.pi/skills` 加载，也兼容 OpenCode、Agents 和
  Claude 的常用 Skill 目录。Skill 会出现在 Desktop slash 菜单中，并交给 Pi 做原生自动发现；适配器自己的隔离 Pi
  配置目录不会用于存放或扫描 Skill。
- plugin 和 reference 当前不会显示可用内容；交互式 question 尚未接入 Pi；MCP 配置不会启动真实 MCP server，也不会提供
  MCP 资源或模板。
- “始终允许”的权限不会被保存，普通 Pi 工具也不会触发 OpenCode 的权限确认。具体安全边界见下方“工具权限与隔离”。
- 不支持远程工作区；所有会话和文件操作都针对服务进程可直接访问的本地或 WSL 文件系统。
- 会话回退只影响模型对话上下文，不恢复工作区文件。已经执行的写文件、编辑和 shell 副作用需要用户自行
  通过版本控制或其他方式恢复。
- 部分 Desktop 版本在重新加载历史消息后，推理、工具调用和文本的显示顺序可能与实时过程不同。需要时可使用
  `--msg-part-encap` 兼容这些版本，但会增加消息数量，并降低长会话的加载和翻页效率。

综合上述兼容情况，在日常连接 OpenCode Desktop、且服务仅运行于可信本机环境时，推荐使用：

```bash
opencode-server-adaptor serve --disable-pty-token-check --msg-part-encap
```

这组参数优先保证终端连接和历史消息显示兼容；如果服务会暴露给其他主机或不可信用户，不应使用
`--disable-pty-token-check`。

### 工具权限与隔离

当前版本不会在 Pi 读取或修改文件、执行命令等操作前请求用户授权。

Pi 及其工具继承启动本服务的操作系统用户权限，本项目也不提供沙箱隔离。`plan` Agent 的只读工具限制仅用于工作流
约束，不应视为安全隔离。请仅在可信工作区中运行；处理不可信代码、提示或自动化任务时，应使用低权限账号，并在容器、
虚拟机或其他操作系统级沙箱中运行本服务，同时只暴露任务所需的文件和凭据。

</details>

## 依赖

- Linux 或 WSL。当前构建产物是 Linux 可执行文件；Windows 开发环境建议在 WSL 中操作。
- [Bun](https://bun.sh/) 1.3.0 或更高版本。
- Pi coding agent CLI，默认应能通过 `~/.bun/bin/pi` 或 `PATH` 找到。
- `bash` 和 `curl`。安装脚本会用它们完成安装及健康检查。
- OpenCode Desktop，仅在需要从桌面端连接本服务时需要。

在本项目使用的 WSL 环境中，先加载 shell 配置，使 `bun` 和 `pi` 可用：

```bash
source ~/.bashrc
bun --version
bun "$(readlink -f "$(command -v pi)")" --version
```

这里显式使用 Bun 执行 Pi 的 JavaScript 入口，以避免 WSL 中系统 `node` 不可用或版本不兼容。适配器自动检测
`~/.bun/bin/bun` 和 `~/.bun/bin/pi` 时也采用相同方式启动 Pi。

如果尚未安装 Pi，可按 Pi 项目的说明安装。使用当前 Pi 包时可以执行：

```bash
bun add --global @earendil-works/pi-coding-agent
```

## 构建和安装

在 WSL 中进入项目目录并安装锁定版本的依赖：

```bash
source ~/.bashrc
cd /mnt/d/wsl-workspace/opensource/opencode-server-adaptor
bun install --frozen-lockfile
```

执行类型检查并构建单文件 Linux 可执行程序：

```bash
bun run typecheck
bun run build
```

默认构建目标是兼容性较好的 `bun-linux-x64-baseline`，产物位于：

```text
dist/opencode-server-adaptor
```

如需同时生成 Linux x64 baseline、x64 modern 和 arm64 产物：

```bash
BUILD_ALL_TARGETS=1 bun run build
```

安装已经构建的程序：

```bash
./scripts/install.sh
```

默认安装到 `~/.local/bin/opencode-server-adaptor`。可以使用 `--prefix PATH` 指定其他安装目录。

如果 OpenCode Desktop 需要从 `~/.opencode/bin/opencode` 启动兼容服务，可以额外创建兼容链接：

```bash
./scripts/install.sh --link-opencode
```

如果该路径已经存在真正的 OpenCode CLI，脚本会拒绝覆盖。只有确认需要替换时才使用
`--link-opencode --force`；原文件会先被备份。

## 命令行选项

通用形式：

```bash
opencode-server-adaptor [全局选项] <命令> [命令选项]
```

常用命令包括 `serve`（启动 HTTP 服务）、`version` / `adaptor-version`（查看版本）、
`compatibility get|set`（管理 OpenCode 兼容版本）和 `help`。运行 `opencode-server-adaptor --help`
可查看完整列表。下面列出最常用的选项；`--help` 的输出与下表一致。

### 全局选项

放在子命令之前，对所有命令生效。

| 选项                  | 说明                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--verbose`           | 输出 HTTP 请求和调试日志到 stderr。开启后会同时启用结构化日志输出并把最低日志级别设为 `DEBUG`（见下方日志选项说明）。也可作为 `serve` 子命令选项放在 `serve` 之后。 |
| `--print-logs`        | 将结构化日志输出到 stderr，但不改变日志级别。                                                                                                                       |
| `--log-level <LEVEL>` | 最低日志级别，取值 `DEBUG`、`INFO`、`WARN`、`ERROR`。显式指定时会覆盖 `--verbose` 带来的 `DEBUG` 默认值；未指定时默认 `INFO`，开启 `--verbose` 时默认 `DEBUG`。     |
| `--version` / `-v`    | 打印 OpenCode 兼容版本并退出。                                                                                                                                      |
| `--help` / `-h`       | 显示帮助信息。                                                                                                                                                      |

三个日志相关选项的关系：`--verbose` 是最完整的一档，等价于同时启用 `--print-logs`、把级别降到 `DEBUG`、并额外打印 HTTP 请求；如果只需要结构化日志而不想降到 `DEBUG`，单独使用 `--print-logs`；`--log-level` 可在任何情况下显式指定级别。

### serve 选项

| 选项                        | 说明                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--hostname <HOST>`         | 监听地址，默认 `127.0.0.1`。                                                                                                                                                             |
| `--port <PORT>`             | 监听端口，默认 `4096`，取值 `0`–`65535`。                                                                                                                                                |
| `--cors <ORIGIN>`           | 允许的 CORS 来源，可重复指定。                                                                                                                                                           |
| `--verbose`                 | 同全局 `--verbose`，可放在 `serve` 之前或之后。                                                                                                                                          |
| `--disable-pty-token-check` | 跳过 PTY WebSocket 的 connect-ticket 校验，允许客户端不带 ticket 直接升级连接。仅用于兼容部分 OpenCode Desktop 版本的 PTY 连接问题（详见“启动服务”一节）；不要在对公网暴露的服务上使用。 |
| `--api-version <VERSION>`   | 选择暴露的 API 协议版本，取值 `v1` 或 `v2`，默认 `v2`。详见上方“OpenCode 协议兼容”一节。                                                                                                 |
| `--disable-v1-compatible`   | 不挂载兼容层路由（`GET /config`、`DELETE /session/:id`、`GET /file`、`GET /file/content`、`GET /find/file`）。关闭后 Desktop 文件树和相关兼容功能可能不可用。                            |
| `--msg-part-encap`          | 将服务端生成的每个 assistant part 封装到独立 assistant message，用 message 顺序兼容 Desktop 的 v2 历史重载；默认关闭。用户 prompt 的 text/file/agent 等 part 不拆分。                    |

## 启动服务

使用安装后的程序启动：

```bash
opencode-server-adaptor serve --hostname 127.0.0.1 --port 4096
```

服务默认启用 v2 协议。`/api/health` 返回当前进程的数值型 `pid`，`/global/health` 不注册并返回
404，以符合 OpenCode 客户端的协议探测规则。如需改用 v1 协议接口，加上 `--api-version=v1`：

```bash
opencode-server-adaptor serve --api-version=v1 --hostname 127.0.0.1 --port 4096
```

v1 模式下挂载 v1 路由和兼容层，v2 的 `/api/*` 接口不可用；v2 模式下挂载 v2 路由和兼容层，v1 专属接口不可用。

如果使用的 Desktop 在切换标签页、重载历史后按 part ID 重新排序，导致 reasoning、工具和文本顺序与实时流不同，可以启用：

```bash
opencode-server-adaptor serve --msg-part-encap --hostname 127.0.0.1 --port 4096
```

该模式下，同一用户轮次仍可对应多条 assistant message，但每条最多包含一个 part。中间 message 不携带最终
`finish`/usage；最后一条 message 保存整轮的终态和 usage。所有 message 完成不会提前结束执行，服务仍只在后端运行真正
settled 后将 session 切换为 `idle`。这会增加 message 数量和历史分页开销，因此仅建议用于需要该兼容行为的客户端。

也可以直接从源码启动：

```bash
bun run src/cli.ts serve --hostname 127.0.0.1 --port 4096
```

默认监听 `127.0.0.1:4096`。需要排查问题时可启用详细日志（选项说明见“命令行选项”一节）：

```bash
opencode-server-adaptor --verbose serve --hostname 127.0.0.1 --port 4096
```

某些 OpenCode Desktop 版本的 v2 PTY `connectToken` 调用尚未接好，连接终端时拿不到 ticket 会被服务端
403 拒绝。此时可以加上 `--disable-pty-token-check` 放宽校验（选项说明见“命令行选项”一节）：

```bash
opencode-server-adaptor serve --disable-pty-token-check --hostname 127.0.0.1 --port 4096
```

该选项仅放宽 PTY 终端连接的 ticket 校验，不影响其他接口；PTY 仍要求会话存在且属于当前 directory、
进程处于 running 状态。不要在对公网暴露的服务上使用。

PTY 终端在没有客户端消费（WebSocket 断开且无订阅者）超过 15 分钟后会被服务端自动关闭并回收，
避免客户端崩溃或断网后留下孤儿 shell 进程。客户端在线时（WebSocket 保持连接）不会触发回收。
PTY 进程退出时服务端会立即移除对应会话并通知客户端，随后重连该 PTY 会得到 404。

常用运行配置示例：

```bash
export OPENCODE_SERVER_USERNAME="opencode"
export OPENCODE_SERVER_PASSWORD="change-me"
#export PI_PROVIDER="my-provider"
#export PI_MODEL="my-model-id"

opencode-server-adaptor serve --hostname 127.0.0.1 --port 4096
```

`PI_PROVIDER` 是 `models.json` 中 `providers` 对象的键，`PI_MODEL` 是该 provider 的 `models[].id`，两者不是
展示名称。未设置时，Pi 使用自己的默认 provider/model 选择。

## 环境变量

所有配置均可通过环境变量覆盖，环境变量优先级高于配置文件（`~/.config/opencode-server-adaptor/config.json`）。
除下表列出者外，`--help` 的 `ENVIRONMENT` 区块也会列出认证相关变量。未显式说明的数值型变量解析失败时回退到默认值。
开发调优相关的 Agent 进程与子任务参数见 [AGENTS.md](./AGENTS.md)。

### 认证

| 变量                       | 说明                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENCODE_SERVER_PASSWORD` | 启用 HTTP Basic Auth 的关键变量。设置后服务开启认证；未设置或空字符串时不启用。注意只判断该变量，不判断 `OPENCODE_SERVER_USERNAME`。 |
| `OPENCODE_SERVER_USERNAME` | Basic Auth 用户名。未设置但已设密码时默认为 `opencode`；未设密码时为 `null`（不启用认证）。                                          |

认证为明文 HTTP Basic Auth，仅适用于 `127.0.0.1` 本地或受信网络。对公网暴露务必加 TLS 反代。

### 服务与路径

| 变量                              | 说明                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                            | 监听地址，默认 `127.0.0.1`。                                                                                              |
| `PORT`                            | 监听端口，默认 `4096`。                                                                                                   |
| `DATABASE_PATH`                   | SQLite 数据库路径，默认 `~/.local/state/opencode-server-adaptor/adaptor.db`。设为 `:memory:` 使用内存库（主要用于测试）。 |
| `PROVIDER_CONFIG_PATH`            | `providers.yaml` 路径。未设置时与配置目录同目录；当 `DATABASE_PATH=:memory:` 时为空字符串。                               |
| `XDG_STATE_HOME`                  | 状态目录前缀，覆盖默认的 `~/.local/state`。                                                                               |
| `XDG_CONFIG_HOME`                 | 配置目录前缀，覆盖默认的 `~/.config`。                                                                                    |
| `OPENCODE_ADAPTOR_COMPAT_VERSION` | 覆盖 OpenCode 兼容版本（如 `1.18.7`），优先级高于配置文件和内置默认值。                                                   |
| `OPENCODE_CLIENT`                 | 标记当前 OpenCode 客户端类型，主要供内部识别。                                                                            |
| `LOG_LEVEL`                       | 默认日志级别，取值 `DEBUG`、`INFO`、`WARN`、`ERROR`，默认 `INFO`。命令行 `--log-level` 和 `--verbose` 优先于此变量。      |

### Pi 后端

| 变量                | 说明                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PI_CLI_PATH`       | Pi CLI 启动命令，默认通过 `~/.bun/bin/bun` 执行 `~/.bun/bin/pi`。WSL 中建议显式设为 `$HOME/.bun/bin/bun $HOME/.bun/bin/pi`。 |
| `PI_PROVIDER`       | 默认 Pi provider 键（`models.json` 中 `providers` 对象的键，非展示名称）。                                                   |
| `PI_MODEL`          | 默认 Pi model ID（`models[].id`，非展示名称）。                                                                              |
| `PI_SESSION_DIR`    | Pi 会话数据目录，默认 `~/.local/state/opencode-server-adaptor/pi-sessions`。                                                 |
| `DEFAULT_AGENT`     | 默认 Agent 后端，默认 `pi`。                                                                                                 |
| `DEFAULT_WORKSPACE` | 默认工作目录，默认当前目录。                                                                                                 |

`providers.yaml` 的完整字段说明和示例见 [AGENTS.md](./AGENTS.md)。
