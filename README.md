# OpenCode Feishu Live

通过飞书机器人实时驱动 `opencode`（基于官方 **ACP / Agent Client Protocol** 事件流），把执行状态**逐条实时**回传到飞书会话：

- 🧠 **思考中 / 思考完成**（推理过程的开始与结束，含字数）
- 🔧 **工具调用全生命周期**：准备调用 → 执行中 → 完成/失败（含耗时与输出预览）
- ✍️ **过程文本**：模型执行中说出的内容按段落即时发出
- 📊 **实时状态卡片**：单条消息原地刷新（头部状态 + 活动记录滚动窗口 + 模型/任务信息）
- 🔐 **权限请求**自动应答（可配置 allow/reject），并在卡片中记录

与旧版 `opencode-feishu-bridge` 的区别：不再解析 CLI 的一次性 JSON 输出，而是直连 opencode 的 ACP 服务（`opencode acp`），因此能拿到**流式**的思考块、工具开始/进行/完成事件，以及逐段文本。

## 架构

```
飞书长连接(WS) ──► Bridge ──► ACP 连接（子进程: opencode acp）
                     │             │
                     │             ├─ session/new   (每个飞书会话一个 ACP 会话)
                     │             ├─ session/prompt (发送任务)
                     │             ├─ session/update (思考/工具/文本/用量 事件流)
                     │             └─ session/cancel (中断)
                     └─► 状态卡片（原地刷新）+ 过程文本消息 + 完成小结
```

## 环境要求

- Node.js >= 18
- `opencode` 已安装且可用（`OPENCODE_PATH`）
- 飞书自建应用（长连接模式 + 机器人能力），权限见下

## 飞书后台配置

1. 订阅方式：**长连接**
2. 事件：`im.message.receive_v1`
3. 权限：
   - `im:message:send_as_bot`（发消息）
   - `im:message.p2p_msg:readonly`（接收单聊消息）
   - `im:message.group_at_msg:readonly`（接收群聊 @ 消息）
   - `im:message:readonly`（读取消息/下载消息中的文件）
   - `im:resource`（上传图片/文件资源）

> 状态卡片刷新使用「更新消息卡片」接口（PATCH），编辑文本消息使用「编辑消息」接口（PUT），两者均可用上行权限覆盖。

## 快速开始

```bash
npm install
cp .env.example .env.runtime
# 编辑 .env.runtime 填入 FEISHU_APP_ID / FEISHU_APP_SECRET 等
bash scripts/preflight.sh
npm run build
bash scripts/install-systemd-user.sh
```

常用命令：

```bash
systemctl --user status opencode-feishu-live.service --no-pager
systemctl --user restart opencode-feishu-live.service
tail -f logs/systemd-bridge.log
```

## 飞书内使用

- 直接发任务文本（群聊需 @机器人，`REQUIRE_MENTION=false` 可关闭）
- 内置命令：
  - `!help` / `!h` — 帮助
  - `!status` / `!s` — 系统状态
  - `!history` / `!hist` — 最近任务
  - `!stop` — 中断当前任务
  - `/new` — 新开会话（重置上下文）
  - `/model list|current|reset|<model_id>` — 模型切换（会话级，不丢上下文）
  - `/notify quiet|normal|debug` — 状态推送模式
  - `!sendfile <path>` — 把服务器本地文件发到飞书
- 发送文件后再发任务文本：文件会自动附带进该次任务

## 推送模式

| 模式 | 行为 |
|------|------|
| `quiet` | 不发状态卡片；只发过程文本与最终结果 |
| `normal`（默认） | 实时状态卡片 + 过程文本 + 完成小结 |
| `debug` | 上述全部 + 推理预览 + 更完整的工具输出 |

## 主要配置项（.env.runtime）

| 变量 | 默认 | 说明 |
|------|------|------|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | — | 必填 |
| `OPENCODE_PATH` | `opencode` | opencode 可执行文件路径 |
| `OPENCODE_WORKING_DIR` | `.` | 任务工作目录（也是 ACP 会话的 cwd） |
| `OPENCODE_MODEL` | 空 | 默认模型（如 `opencode/deepseek-v4.1-flash-free`） |
| `OPENCODE_STATUS_ENABLED` | `true` | 实时状态卡片开关 |
| `OPENCODE_STATUS_INTERVAL` | `1200` | 卡片最小刷新间隔（毫秒） |
| `OPENCODE_STATUS_LINES` | `12` | 卡片活动记录滚动显示行数 |
| `OPENCODE_STATUS_SHOW_REASONING` | `false` | 卡片中是否附推理预览 |
| `OPENCODE_STATUS_SHOW_TOOL_OUTPUT` | `true` | 工具完成时附输出预览（首几行，截断） |
| `OPENCODE_INTERIM_TEXT` | `true` | 过程文本按段发出 |
| `OPENCODE_INTERIM_TEXT_MIN` | `24` | 小于该字数的文本块暂存合并 |
| `OPENCODE_COMPLETION_FOOTER` | `true` | 完成后发一条小结（用时/tokens） |
| `OPENCODE_PERMISSION_MODE` | `allow` | ACP 权限请求自动应答 |
| `OPENCODE_NOTIFY_DEFAULT` | `normal` | 默认推送模式 |
| `REQUIRE_MENTION` | `true` | 群聊是否必须 @机器人 |

## 二次开发提示

- `src/agent/acp-connection.ts`：opencode acp 子进程管理（含断线重连）
- `src/agent/live-session.ts`：ACP 会话封装 + 事件翻译（ActivityEvent）
- `src/status/live-card.ts`：状态卡片渲染与刷新（卡片 → 文本编辑 → 限流消息 三级降级）
- `src/index.ts`：飞书消息编排（会话、队列、过程文本、完成小结）
- 调试：`node dist/dev-drive.js "任务内容"` 可在无飞书环境下观察完整实时流

## License

MIT
