# opencode-server-adaptor

`opencode-server-adaptor` 是一个兼容 OpenCode Server API 的 Agent 适配服务。它实现了 OpenCode Desktop
所需的 CLI、HTTP REST API 和 SSE 事件流，并将 OpenCode 的会话、消息、工具调用、权限确认和子智能体操作转换为
后端 Agent 的运行协议。

目前项目只接入了 Pi coding agent，但核心实现支持扩展其他 Agent 后端。接口分层、生命周期、子智能体方案、重启恢复
约定和新后端接入方法见 [INTERFACE.md](./INTERFACE.md)。

Pi 接入支持 Pi 原生的自动/手动会话压缩，并通过 SSE 返回压缩生命周期事件。服务还提供 `plan` 主 Agent；它基于
Pi 官方 `examples/extensions/plan-mode` 的实现方式，禁用写工具并限制 shell 为只读命令。
会话回退使用 Pi RPC `fork(entryId)`，只回退模型对话上下文，不恢复工作区文件；在回退后继续发送消息前也可以通过
OpenCode `unrevert` 切回原会话。

## OpenCode 协议兼容

当前兼容目标为 OpenCode `1.18.7`，服务仅实现 OpenCode v2 协议。接口主要位于 `/api/*`，包括健康检查、
位置、Agent、模型与 provider、会话、消息、持久事件流、权限、认证、文件系统、命令、技能、引用和 PTY 等接口。

所有会话接口共用同一个 `SessionService`、Runtime、消息仓库和事件处理流程。会话事件使用独立的持久事件序列；
客户端可以通过游标或 `Last-Event-ID` 断点续传。V1 的 `/session`、`/global/event`、`/global/health`
等入口不再注册。详细的分层约定见 [INTERFACE.md](./INTERFACE.md)。

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

| 选项 | 说明 |
|------|------|
| `--verbose` | 输出 HTTP 请求和调试日志到 stderr。开启后会同时启用结构化日志输出并把最低日志级别设为 `DEBUG`（见下方日志选项说明）。也可作为 `serve` 子命令选项放在 `serve` 之后。 |
| `--print-logs` | 将结构化日志输出到 stderr，但不改变日志级别。 |
| `--log-level <LEVEL>` | 最低日志级别，取值 `DEBUG`、`INFO`、`WARN`、`ERROR`。显式指定时会覆盖 `--verbose` 带来的 `DEBUG` 默认值；未指定时默认 `INFO`，开启 `--verbose` 时默认 `DEBUG`。 |
| `--version` / `-v` | 打印 OpenCode 兼容版本并退出。 |
| `--help` / `-h` | 显示帮助信息。 |

三个日志相关选项的关系：`--verbose` 是最完整的一档，等价于同时启用 `--print-logs`、把级别降到 `DEBUG`、并额外打印 HTTP 请求；如果只需要结构化日志而不想降到 `DEBUG`，单独使用 `--print-logs`；`--log-level` 可在任何情况下显式指定级别。

### serve 选项

| 选项 | 说明 |
|------|------|
| `--hostname <HOST>` | 监听地址，默认 `127.0.0.1`。 |
| `--port <PORT>` | 监听端口，默认 `4096`，取值 `0`–`65535`。 |
| `--cors <ORIGIN>` | 允许的 CORS 来源，可重复指定。 |
| `--verbose` | 同全局 `--verbose`，可放在 `serve` 之前或之后。 |
| `--disable-pty-token-check` | 跳过 PTY WebSocket 的 connect-ticket 校验，允许客户端不带 ticket 直接升级连接。仅用于兼容部分 OpenCode Desktop 版本的 PTY 连接问题（详见“启动服务”一节）；不要在对公网暴露的服务上使用。 |
| `--mdns` / `--mdns-domain <DOMAIN>` | mDNS 相关选项，当前未实现，仅打印警告。 |

## 启动服务

使用安装后的程序启动：

```bash
opencode-server-adaptor serve --hostname 127.0.0.1 --port 4096
```

服务始终声明并提供 v2 协议：`/api/health` 返回当前进程的数值型 `pid`，`/global/health` 不注册并返回
404，以符合 OpenCode 客户端的协议探测规则。旧的 `--api-version` 启动参数已移除。

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
避免客户端崩溃或断网后留下孤儿 shell 进程。客户端在线时（WebSocket 保持连接）不会触发回收；
已退出的 PTY 会话记录同样在 15 分钟后从服务端移除。回收时会发布 `pty.deleted` 事件，
客户端重连该 PTY 会得到 404。

常用运行配置示例：

```bash
export PI_PROVIDER="my-provider"
export PI_MODEL="my-model-id"
export PI_CLI_PATH="$HOME/.bun/bin/bun $HOME/.bun/bin/pi"
export OPENCODE_SERVER_USERNAME="opencode"
export OPENCODE_SERVER_PASSWORD="change-me"

opencode-server-adaptor serve --hostname 127.0.0.1 --port 4096
```

`PI_PROVIDER` 是 `models.json` 中 `providers` 对象的键，`PI_MODEL` 是该 provider 的 `models[].id`，两者不是
展示名称。未设置时，Pi 使用自己的默认 provider/model 选择。

## 环境变量

所有配置均可通过环境变量覆盖，环境变量优先级高于配置文件（`~/.config/opencode-server-adaptor/config.json`）。
除下表列出者外，`--help` 的 `ENVIRONMENT` 区块也会列出认证相关变量。未显式说明的数值型变量解析失败时回退到默认值。

### 认证

| 变量 | 说明 |
|------|------|
| `OPENCODE_SERVER_PASSWORD` | 启用 HTTP Basic Auth 的关键变量。设置后服务开启认证；未设置或空字符串时不启用。注意只判断该变量，不判断 `OPENCODE_SERVER_USERNAME`。 |
| `OPENCODE_SERVER_USERNAME` | Basic Auth 用户名。未设置但已设密码时默认为 `opencode`；未设密码时为 `null`（不启用认证）。 |

认证为明文 HTTP Basic Auth，仅适用于 `127.0.0.1` 本地或受信网络。对公网暴露务必加 TLS 反代。

### 服务与路径

| 变量 | 说明 |
|------|------|
| `HOST` | 监听地址，默认 `127.0.0.1`。 |
| `PORT` | 监听端口，默认 `4096`。 |
| `DATABASE_PATH` | SQLite 数据库路径，默认 `~/.local/state/opencode-server-adaptor/adaptor.db`。设为 `:memory:` 使用内存库（主要用于测试）。 |
| `PROVIDER_CONFIG_PATH` | `providers.yaml` 路径。未设置时与配置目录同目录；当 `DATABASE_PATH=:memory:` 时为空字符串。 |
| `XDG_STATE_HOME` | 状态目录前缀，覆盖默认的 `~/.local/state`。 |
| `XDG_CONFIG_HOME` | 配置目录前缀，覆盖默认的 `~/.config`。 |
| `OPENCODE_ADAPTOR_COMPAT_VERSION` | 覆盖 OpenCode 兼容版本（如 `1.18.7`），优先级高于配置文件和内置默认值。 |
| `OPENCODE_CLIENT` | 标记当前 OpenCode 客户端类型，主要供内部识别。 |
| `LOG_LEVEL` | 默认日志级别，取值 `DEBUG`、`INFO`、`WARN`、`ERROR`，默认 `INFO`。命令行 `--log-level` 和 `--verbose` 优先于此变量。 |

### Pi 后端

| 变量 | 说明 |
|------|------|
| `PI_CLI_PATH` | Pi CLI 启动命令，默认通过 `~/.bun/bin/bun` 执行 `~/.bun/bin/pi`。WSL 中建议显式设为 `$HOME/.bun/bin/bun $HOME/.bun/bin/pi`。 |
| `PI_PROVIDER` | 默认 Pi provider 键（`models.json` 中 `providers` 对象的键，非展示名称）。 |
| `PI_MODEL` | 默认 Pi model ID（`models[].id`，非展示名称）。 |
| `PI_SESSION_DIR` | Pi 会话数据目录，默认 `~/.local/state/opencode-server-adaptor/pi-sessions`。 |
| `DEFAULT_AGENT` | 默认 Agent 后端，默认 `pi`。 |
| `DEFAULT_WORKSPACE` | 默认工作目录，默认当前目录。 |

### Agent 进程与子任务

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_ACTIVE_AGENT_PROCESSES` | `3` | 同时存活的 Pi 子进程上限。 |
| `AGENT_IDLE_TIMEOUT_MS` | `300000` | Agent 进程空闲回收超时（毫秒）。 |
| `AGENT_START_TIMEOUT_MS` | `30000` | Agent 进程启动超时。 |
| `AGENT_RPC_TIMEOUT_MS` | `120000` | 与 Agent 进程单次 RPC 调用超时。 |
| `MAX_GLOBAL_CONCURRENT_SUBTASKS` | `8` | 全局并发子任务上限。 |
| `MAX_CONCURRENT_SUBTASKS_PER_PARENT` | `4` | 单个父任务并发子任务上限。 |
| `MAX_SUBTASK_DEPTH` | `3` | 子任务嵌套最大深度。 |
| `SUBTASK_TIMEOUT_MS` | `120000` | 单个子任务超时。 |
| `SUBTASK_AGENT_SCOPE` | `both` | 子任务 Agent 作用域，取值 `user`、`project`、`both`。 |
| `SUBTASK_TERMINATE_GRACE_PERIOD_MS` | `5000` | 终止子任务的优雅关闭宽限期。 |
| `SUBTASK_STDERR_LIMIT_BYTES` | `1048576` | 子任务 stderr 捕获上限字节数。 |

默认状态目录是 `~/.local/state/opencode-server-adaptor`，其中包含：

- `adaptor.db`：会话、消息和权限状态。
- `pi/models.json`：服务启动时生成的 Pi 模型配置。
- `pi/auth.json` 和 `pi/opencode-adaptor-runtime/`：同步给 Pi 子进程的认证及运行扩展。
- `pi-sessions/`：Pi 会话数据。

默认配置目录是 `~/.config/opencode-server-adaptor`，其中 `providers.yaml` 保存用户可编辑的 provider、模型和默认模型。

服务启动时会读取 `~/.pi/agent/models.json`，合并 `providers.yaml` 中的 provider、model 和 API key，然后完整写入
状态目录下的 `pi/models.json`。provider、model 和 API key 都只读取 YAML，不会从 SQLite 迁移。当前业务表只保留
`sessions`、`messages`、`parts`、`permissions` 和 v2 断点续传使用的 `session_events`。

项目当前处于开发阶段，不维护数据库 migration 或 `_migrations` 表。代码只初始化最新 schema；已有数据库需要改表时，
直接同步修改开发数据库。

`providers.yaml` 示例：

```yaml
# 默认模型。格式必须是 <provider-id>/<model-id>。
model: my-provider/my-model-id

provider:
  # provider-id 是传给 Agent 后端的 provider 标识。
  my-provider:
    # 本层字段均可选；models 中至少需要一个模型才能出现在客户端模型列表。
    name: My Provider
    # 可选值：anthropic-messages、openai-completions、openai-responses、
    # azure-openai-responses、openai-codex-responses、mistral-conversations、
    # google-generative-ai、google-vertex、bedrock-converse-stream。
    # 省略时适配器使用 openai-completions。
    api: openai-completions
    baseUrl: https://gateway.example/v1
    # API key 的唯一配置位置。可以是明文、$ENV_VAR、${ENV_VAR} 或 !command；
    # 这些引用由 Pi 在调用模型时解析。
    apiKey: ${MY_PROVIDER_API_KEY}
    headers:
      x-tenant: tenant-a
    # 可选值：true、false。true 表示自动添加 Authorization: Bearer <apiKey>。
    authHeader: true

    # Agent 后端专属字段。custom.pi 下的内容不转换，直接深合并到 Pi provider 配置。
    custom:
      pi:
        compat:
          supportsDeveloperRole: false

    models:
      # model-id 是传给 Agent 后端的模型标识。
      my-model-id:
        # 本层字段均可选，可以覆盖 provider 层的 api 和 baseUrl。
        name: My Model
        api: openai-completions
        baseUrl: https://model-gateway.example/v1
        # 可选值：true、false。
        reasoning: true
        # key 可选值：off、minimal、low、medium、high、xhigh、max；
        # value 为后端使用的字符串，null 表示不支持该等级。
        thinkingLevelMap:
          off: null
          minimal: null
          low: low
          medium: medium
          high: high
          xhigh: null
          max: max
        # 元素可选值：text、image。
        input: [text, image]
        # 正整数。适配器将其返回为 OpenCode model.limit.context，客户端据此展示上下文占用百分比；
        # 同时原样生成到 Pi models.json，供 Pi 计算上下文用量及触发自动压缩。
        contextWindow: 200000
        # 正整数。模型单次响应的最大输出 token 数；返回为 OpenCode model.limit.output，
        # 同时原样生成到 Pi models.json。
        maxTokens: 32000
        headers:
          x-model-route: primary

        # custom.pi 下的内容不转换，直接深合并到 Pi model 配置。
        custom:
          pi:
            compat:
              supportsDeveloperRole: false
```

也可以通过 v2 的 `POST /api/integration/:providerID/connect/key` 管理 API key；该接口会直接更新已有 provider
的 `apiKey` 字段，不再写入 SQLite。provider 必须先存在于 `providers.yaml`，未知 provider 会返回
`InvalidRequestError`。

上面的 YAML 样例包含适配器识别的全部字段。provider 或 model 下的 `custom.pi` 可以使用任意 Pi 配置；生成
`pi/models.json` 时会深合并到对应对象。未配置 `contextWindow` 或 `maxTokens` 时，对应 OpenCode limit 返回 `0`，
且不会向 Pi 生成该字段；因此需要客户端展示上下文百分比时，模型必须配置 `contextWindow`。
`PROVIDER_CONFIG_PATH` 可以覆盖 YAML 路径；未覆盖时它始终与
`config.json` 位于同一个配置目录。V2 不提供通用配置写入接口；provider 和 model 结构应直接在该 YAML 文件中维护。

也可以把非敏感配置写入
`~/.config/opencode-server-adaptor/config.json`，例如：

```json
{
  "piProvider": "my-provider",
  "piModel": "my-model-id",
  "piCliPath": "/home/user/.bun/bin/bun /home/user/.bun/bin/pi",
  "defaultWorkspace": "/home/user/workspace",
  "logLevel": "INFO"
}
```

环境变量优先于配置文件。包含密码和 API Key 的配置不应提交到版本库。

## 测试

运行类型检查：

```bash
source ~/.bashrc
bun run typecheck
```

运行默认测试套件：

```bash
bun test
```

默认测试包含单元测试、契约测试、Fake Pi 集成测试和 WSL 兼容测试。真实 Pi 测试默认跳过，不会发起模型调用。
WSL 兼容测试会检查 `dist/opencode-server-adaptor` 和默认安装路径，因此运行完整套件前应先按上文完成构建和安装。

运行单个测试文件或匹配的用例：

```bash
bun test tests/integration/fake-pi-integration.test.ts
bun test tests/integration/fake-pi-integration.test.ts -t "model-invoked task"
```

## 配置并运行真实 Pi 测试

真实测试从 `~/.pi/agent/models.json` 读取 provider 定义。以下是一个 OpenAI Chat Completions
兼容服务的最小示例；请替换 endpoint、环境变量和模型 ID：

```json
{
  "providers": {
    "my-provider": {
      "name": "My Provider",
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MY_PROVIDER_API_KEY",
      "models": [
        {
          "id": "my-model-id",
          "name": "My Model",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

设置 API Key，并显式指定要测试的 provider 键和模型 ID：

```bash
source ~/.bashrc
export MY_PROVIDER_API_KEY="replace-with-real-key"
export RUN_REAL_PI_TESTS=1
export REAL_PI_PROVIDER="my-provider"
export REAL_PI_MODEL="my-model-id"

bun test tests/contract/real-pi-scenarios.test.ts --timeout 300000
```

`REAL_PI_PROVIDER` 和 `REAL_PI_MODEL` 必须同时设置。如果两者都不设置，测试会选择
`~/.pi/agent/models.json` 中第一个具有有效 `models[].id` 的 provider/model。建议始终显式设置，以免测试到错误
或计费不同的模型。

如需让真实测试使用已经构建的服务，而不是通过 Bun 从源码启动：

```bash
export REAL_PI_SERVER_EXECUTABLE="$PWD/dist/opencode-server-adaptor"
```

可以先执行单个真实场景降低排查成本：

```bash
bun test tests/contract/real-pi-scenarios.test.ts -t "simple text prompt" --timeout 300000
bun test tests/contract/real-pi-scenarios.test.ts -t "model-native subagent" --timeout 300000
bun test tests/contract/real-pi-scenarios.test.ts -t "approve flow" --timeout 300000
```

完整真实测试会发起实际模型请求，并覆盖正常对话、推理、工具调用、权限确认、多轮对话、连续执行、标题生成、
子智能体、并行/链式子任务、终止和持久化等场景，可能产生模型费用，并会在临时目录中执行受测试约束的命令。

v2 协议还有一个最小真实模型烟雾测试，它通过 v2 创建会话、提交 prompt、等待完成并读取 v2 消息：

```bash
RUN_REAL_PI_TESTS=1 bun test tests/contract/real-pi-v2.test.ts --timeout 300000
```
