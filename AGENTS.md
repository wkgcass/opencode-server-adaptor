# 开发与测试指南

本文档面向项目开发者，涵盖架构设计、配置细节和测试规范。面向最终用户的的安装、启动和运行时配置见
[README.md](./README.md)。接口分层、生命周期、子智能体方案、重启恢复约定和新后端接入方法见
[INTERFACE.md](./INTERFACE.md)。

## 架构设计

### 分层与依赖方向

- `src/api/routes` 是 OpenCode 协议适配层，只做请求校验、协议对象转换和 HTTP/SSE 响应；其中会话、权限等独立生命周期
  按领域拆分路由模块。
- `SessionService` 和 `AgentService` 是应用层。前者统一会话用例，后者统一 Runtime、事件投影与子任务编排。
- `SessionRepository`、`MessageRepository`、`PermissionRepository` 和 `SessionEventStore` 是持久化边界。应用服务和路由
  不应绕过仓库直接执行对应业务表 SQL。
- `src/provider` 保存与 HTTP 无关的 provider/model 目录模型；`src/api/provider.ts` 只保留兼容导出。
- `AgentIntegration` → `AgentAdapter` → `AgentRuntime` 是后端依赖方向；Pi 专属实现只允许位于 `src/agents/pi` 和明确标注的
  vendor 目录。通用应用层不得导入 Pi 类型。

`src/server.ts` 是组合根，负责创建仓库、应用服务、后端 integration 和协议路由。新增依赖应在组合根显式注入，避免在
业务模块内创建全局单例或反向依赖 HTTP 层。

### OpenCode 协议兼容

当前兼容目标为 OpenCode `1.18.7`。服务同时保留 v2 和 v1 两套协议接口，默认启用 v2，
可通过启动参数 `--api-version=v1` 切换为 v1。

- **v2 协议**（默认）：接口位于 `/api/*`，包括健康检查、位置、Agent、模型与 provider、会话、消息、持久事件流、
  权限、认证、文件系统、命令、技能、引用和 PTY 等接口。会话事件使用独立的持久事件序列，客户端可通过游标或
  `Last-Event-ID` 断点续传。
- **v1 协议**（`--api-version=v1`）：精简的配置与检查层，包含：会话列表与内容、获取 agent 列表、
  provider/model 的增删改查（`PATCH /config`、`DELETE /config/provider/:id`、`DELETE /config/provider/:id/model/:modelID`、
  `PUT/DELETE /auth/:id`）、获取 provider 和模型列表（`GET /config/providers`）、获取项目列表。
  适用于极少数只支持 v1 的场景：先用 v1 启动完成配置，再用 v2 重启。
- **兼容层**（两种模式都挂载，可用 `--disable-v1-compatible` 关闭）：`GET /config`（获取配置对象）、`DELETE /session/:id`（删除会话），以及 OpenCode 桌面端 v1 SDK `File`/`Find` 类实际使用的遗留文件系统接口
  `GET /file`、`GET /file/content`、`GET /find/file`。前两个接口在 v2 中没有对应实现；文件系统接口虽然在 v2 中有 `/api/fs/*` 对应实现，但桌面端的文件树仍通过 v1 SDK 调用 `/file` 与 `/file/content`，因此这些接口在两种模式下都可用。v1 SDK 中未被桌面端调用的 `file.status`、`find.text`、`find.symbols` 未实现，会命中 404。

所有会话接口共用同一个 `SessionService`、Runtime、消息仓库和事件处理流程。

v2 Desktop 历史重载存在按重建 part ID 排序的版本可使用 `--msg-part-encap` 兼容：服务端生成的 assistant part 按连续
相同类型分组，分别放入同一 user turn 下的有序 sibling assistant message；用户 prompt part 不拆。该模式下
`message_completed` 统一完成整组 message，只有 terminal message 保存最终 finish/usage/error；session 是否完成仍只由
`session_idle` 决定。

### Pi 后端设计

目前项目只接入了 Pi coding agent，但核心实现支持扩展其他 Agent 后端。

Pi 接入支持 Pi 原生的自动/手动会话压缩，并通过 SSE 返回压缩生命周期事件。服务还提供 `plan` 主 Agent；它基于
Pi 官方 `examples/extensions/plan-mode` 的实现方式，禁用写工具并限制 shell 为只读命令。
会话回退使用 Pi RPC `fork(entryId)`，只回退模型对话上下文，不恢复工作区文件；在回退后继续发送消息前也可以通过
OpenCode `unrevert` 切回原会话。

### 数据库

默认状态目录是 `~/.local/state/opencode-server-adaptor`，其中包含：

- `adaptor.db`：会话、消息和权限状态。
- `pi/models.json`：服务启动时生成的 Pi 模型配置。
- `pi/auth.json` 和 `pi/opencode-adaptor-runtime/`：同步给 Pi 子进程的认证及运行扩展。
- `pi-sessions/`：Pi 会话数据。

服务启动时会读取 `~/.pi/agent/models.json`，合并 `providers.yaml` 中的 provider、model 和 API key，然后完整写入
状态目录下的 `pi/models.json`。provider、model 和 API key 都只读取 YAML，不会从 SQLite 迁移。当前业务表只保留
`sessions`、`messages`、`parts`、`permissions` 和 v2 断点续传使用的 `session_events`。

session metadata 还保存内部有序 ID 模式。客户端消息 ID 以 `msg-` 开头时，该 session 持久切换到由 44-bit
逻辑毫秒时间戳和 12-bit 同毫秒计数器组成的 wide 排序格式，服务端后续生成 `msg-`、`prt-` 和 `evt-`；subtask
子 session 继承该模式，但 `ses_`、权限、call、PTY 和 RPC ID 不切换。客户端显式提供的 message/part ID 仍原样保留。

项目当前处于开发阶段，不维护数据库 migration 或 `_migrations` 表。代码只初始化最新 schema；已有数据库需要改表时，
直接同步修改开发数据库。

### providers.yaml

默认配置目录是 `~/.config/opencode-server-adaptor`，其中 `providers.yaml` 保存用户可编辑的 provider、模型和默认模型。

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

上面的 YAML 样例包含适配器识别的全部字段。provider 或 model 下的 `custom.pi` 可以使用任意 Pi 配置；生成
`pi/models.json` 时会深合并到对应对象。未配置 `contextWindow` 或 `maxTokens` 时，对应 OpenCode limit 返回 `0`，
且不会向 Pi 生成该字段；因此需要客户端展示上下文百分比时，模型必须配置 `contextWindow`。
`PROVIDER_CONFIG_PATH` 可以覆盖 YAML 路径；未覆盖时它始终与
`config.json` 位于同一个配置目录。V2 不提供通用配置写入接口；provider 和 model 结构应直接在该 YAML 文件中维护，
或通过 v1 模式的 `PATCH /config`、`DELETE /config/provider/*` 等接口管理。

也可以通过 v2 的 `POST /api/integration/:providerID/connect/key` 管理 API key；该接口会直接更新已有 provider
的 `apiKey` 字段，不再写入 SQLite。provider 必须先存在于 `providers.yaml`，未知 provider 会返回
`InvalidRequestError`。

### 开发调优环境变量

以下环境变量用于调整 Agent 进程池和子任务调度行为，通常不需要在运行时修改：

| 变量                                 | 默认值    | 说明                                                  |
| ------------------------------------ | --------- | ----------------------------------------------------- |
| `MAX_ACTIVE_AGENT_PROCESSES`         | `3`       | 同时存活的 Pi 子进程上限。                            |
| `AGENT_IDLE_TIMEOUT_MS`              | `300000`  | Agent 进程空闲回收超时（毫秒）。                      |
| `AGENT_START_TIMEOUT_MS`             | `30000`   | Agent 进程启动超时。                                  |
| `AGENT_RPC_TIMEOUT_MS`               | `120000`  | Agent 短命令 RPC 超时；原生压缩由后端报告终态。       |
| `MAX_GLOBAL_CONCURRENT_SUBTASKS`     | `8`       | 全局并发子任务上限。                                  |
| `MAX_CONCURRENT_SUBTASKS_PER_PARENT` | `4`       | 单个父任务并发子任务上限。                            |
| `MAX_SUBTASK_DEPTH`                  | `3`       | 子任务嵌套最大深度。                                  |
| `SUBTASK_TIMEOUT_MS`                 | `120000`  | 单个子任务超时。                                      |
| `SUBTASK_AGENT_SCOPE`                | `both`    | 子任务 Agent 作用域，取值 `user`、`project`、`both`。 |
| `SUBTASK_TERMINATE_GRACE_PERIOD_MS`  | `5000`    | 终止子任务的优雅关闭宽限期。                          |
| `SUBTASK_STDERR_LIMIT_BYTES`         | `1048576` | 子任务 stderr 捕获上限字节数。                        |

也可以把非敏感配置写入 `~/.config/opencode-server-adaptor/config.json`，例如：

```json
{
  "piProvider": "my-provider",
  "piModel": "my-model-id",
  "defaultWorkspace": "/home/user/workspace",
  "logLevel": "INFO"
}
```

环境变量优先于配置文件。包含密码和 API Key 的配置不应提交到版本库。

## 测试

### 测试执行规范

**测试输出量很大，不允许用 `grep` 过滤实时输出。** 必须将全部输出（含 stderr）重定向到文件，
执行完成后再回头查看文件内容：

```bash
bun test > /tmp/test.log 2>&1
```

查看结果时直接读取文件末尾的汇总行（`N pass / N fail / N skip`），需要排查具体失败再搜索文件内容。

从 Windows PowerShell 调用 WSL 时，应使用交互式 Bash 并加载 `~/.bashrc`。本机的 Bun 路径由 `.bashrc`
加入 `PATH`；使用 `wsl bash -lc 'source ~/.bashrc; ...'` 这类非交互 shell 时，`.bashrc` 可能在开头提前返回，
导致 `bun: command not found`。可先用以下命令确认环境：

```powershell
wsl bash -ic 'source ~/.bashrc; command -v bun; bun --version'
```

在当前仓库运行类型检查和默认测试的可用 PowerShell 命令如下。测试日志保存在 WSL 的 `/tmp` 中，并且只在
测试进程结束后输出末尾汇总：

```powershell
wsl bash -ic 'source ~/.bashrc; cd /mnt/d/wsl-workspace/opensource/opencode-server-adaptor; bun run typecheck'
wsl bash -ic 'source ~/.bashrc; cd /mnt/d/wsl-workspace/opensource/opencode-server-adaptor; bun test > /tmp/opencode-adaptor-test.log 2>&1; code=$?; tail -n 100 /tmp/opencode-adaptor-test.log; exit $code'
```

不要直接在 PowerShell 中运行完整测试。测试使用 Linux/WSL 路径语义，并包含 WSL Desktop 兼容测试；直接在
Windows Bun 下执行会把 `/tmp` 等路径解释成 Windows 路径，产生与代码无关的失败及后续连接错误。

### 类型检查

```bash
source ~/.bashrc
bun run typecheck
```

### 默认测试套件

```bash
bun test > /tmp/test.log 2>&1
```

默认测试包含单元测试、契约测试、Fake Pi 集成测试和 WSL 兼容测试。真实 Pi 测试默认跳过，不会发起模型调用。
WSL 兼容测试会检查 `dist/opencode-server-adaptor` 和默认安装路径，因此运行完整套件前应先按 README 完成构建和安装。

运行单个测试文件或匹配的用例（输出较少时可直接看终端）：

```bash
bun test tests/integration/fake-pi-integration.test.ts
bun test tests/integration/fake-pi-integration.test.ts -t "model-invoked task"
```

### 真实 Pi 测试

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

bun test tests/contract/real-pi-scenarios.test.ts --timeout 300000 > /tmp/test.log 2>&1
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

全量运行（含真实 Pi 测试）并将输出重定向到文件：

```bash
RUN_REAL_PI_TESTS=1 REAL_PI_PROVIDER="my-provider" REAL_PI_MODEL="my-model-id" \
  bun test > /tmp/test.log 2>&1
```

v2 协议还有一个最小真实模型烟雾测试，它通过 v2 创建会话、提交 prompt、等待完成并读取 v2 消息：

```bash
RUN_REAL_PI_TESTS=1 bun test tests/contract/real-pi-v2.test.ts --timeout 300000
```
