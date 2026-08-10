# Codex / Claude Code Hook 配置格式冻结（2026-08-04）

状态：官方格式已复核；安全只读检查、无损接入/撤销与内部事务原型已实现；真实配置入口仍关闭  
范围：Windows 用户级任务守望连接器，不包含管理员策略或插件安装

## 1. 官方依据

- Codex Hooks：<https://learn.chatgpt.com/docs/hooks>
- Codex 配置参考：<https://learn.chatgpt.com/docs/config-reference>
- Claude Code Hooks：<https://code.claude.com/docs/en/hooks>
- Claude Code 设置：<https://code.claude.com/docs/en/configuration>

本页只冻结 2026-08-04 官方文档所述配置外形和事件语义。目标版本号、真实脱敏载荷、升级兼容与实机退出行为仍是发布门，不能因为格式已复核就宣称连接器可用。

## 2. Codex 冻结选择

Codex 会从活动配置层同时加载独立 `hooks.json` 和 `config.toml` 内联 `[hooks]`，不同来源的匹配 Hook 会叠加，同一层两种表示同时存在还会在启动时警告。非管理员命令 Hook 必须由用户在 Codex `/hooks` 中审阅并信任其精确内容；条目变化后需要重新审阅。

圆圆未来默认只考虑用户级 `~/.codex/hooks.json`，不自动修改项目仓库。若该层已经使用内联 `[hooks]`，或同时存在两种表示，预览必须报告来源冲突并停止自动写入，不能擅自迁移用户配置。当前只读解析器同时理解：

- `hooks.json`：顶层可有 `description`，Hook 位于 `hooks.<Event>[]`；
- `config.toml`：`[[hooks.<Event>]]` matcher 组以及 `[[hooks.<Event>.hooks]]` command handler；
- command handler 当前只使用官方已执行的 `type = "command"`，超时固定为 1 秒；
- 圆圆永远返回空标准输出并退出 0，不使用 Hook 的阻断、改写、批准、继续或模型上下文能力。

P0 候选事件为 `SessionStart`、`UserPromptSubmit`、`PermissionRequest`、`PostToolUse`、`Stop` 和 `SessionEnd`。`Stop` / `SessionEnd` 不证明任务成功；Codex 当前文档没有可直接证明普通任务失败或取消的专属终态事件。

## 3. Claude Code 冻结选择

Claude Code 的 Hook 位于 JSON 设置中的单一 `hooks` 对象：用户级 `~/.claude/settings.json`、项目级 `.claude/settings.json` 和本地项目级 `.claude/settings.local.json` 会叠加，而不是互相替换。Claude Code 没有独立的 `.claude/hooks.json` 设置文件；插件的 `hooks/hooks.json` 是另一种受插件生命周期控制的来源。

圆圆未来默认只考虑用户级 `~/.claude/settings.json`，使用官方 exec form：handler 的 `command` 只放 Bridge 可执行文件，`args` 数组逐项放参数，避免 Windows 路径和空格被 shell 二次解析。当前只读解析器不会读取或输出其他设置值，只统计 Hook 组、handler 和其他顶层字段数量。项目级和本地项目级来源可以与用户级设置共存；只有圆圆拥有的条目出现在非首选来源或多个来源时才进入人工冲突，不会因为用户自己的项目 Hook 存在就阻断。

P0 候选事件为 `SessionStart`、`UserPromptSubmit`、`PermissionRequest`、`Notification`、`PostToolUse`、`PostToolUseFailure`、`TaskCreated`、`TaskCompleted`、`Stop`、`StopFailure` 和 `SessionEnd`。其中：

- `TaskCompleted` 官方输入没有 `status` / `task_status`；事件本身表示任务正被标记完成；
- 任意额外 `status=failed/cancelled` 都不能让圆圆虚构失败或取消；
- `StopFailure` 明确表示本轮因 API 错误结束，可作为部分失败证据，但错误正文必须丢弃；
- `Stop` 只表示主代理结束回复，不证明用户目标成功；
- 当前没有冻结普通任务的权威取消事件，产品不得显示确定性取消结论。

## 4. 圆圆所有权标记

所有权信息放在官方 command handler 已允许的命令参数里，不给第三方配置对象增加私有字段：

```text
--owner-id yuanyuan-reminder
--connector-id <内置实现标识>.<随机稳定 UUID>
--source-instance <随机稳定 UUID>
--key-id <Credential Manager 引用>
```

`key_id` 只是 `Yuanyuan/TaskEventKey/<key_id>` 的引用，不是密钥正文。Bridge 已接受可选的 `--owner-id yuanyuan-reminder`；其他 owner 值关闭失败。旧调试调用暂时仍可省略该参数，真实新配置必须写入。

所有权判断必须同时满足：command handler 类型为 `command`、Bridge 程序身份匹配、三个所有权标记精确匹配。只凭事件名、matcher、路径片段或 `key_id` 不得认领用户条目。

## 5. 已实现的只读差异模型

`yuanyuan-connectors::config_preview` 对单个配置文件提供 64 KiB 上限的 JSON/TOML 语义解析，并能在一次解析中核对最多 32 个预期 handler：

- `absent`：没有圆圆候选条目，未来动作是新增；
- `exact`：只有一个候选且事件、matcher、handler 字段完全一致，未来动作是无变更；
- `modified`：所有权标记匹配，但事件、matcher、命令、参数、超时或额外字段不同，必须人工复核；
- `duplicate`：出现两个或以上圆圆候选，必须人工复核；
- 无效、超限或非官方结构只报告解析状态，不尝试修复。

集合级结果额外区分：

- `partial`：已有部分 handler 完全一致，其余缺失，未来动作只能是补齐缺失项；
- `conflict`：任一预期 handler 被修改、重复，或发现无法归属到预期事件的圆圆 handler；
- 同一 matcher 组里的用户 handler 与圆圆 handler 分别计数，并标记为混合组，后续撤销不得删除整个 matcher 组；
- 同事件多 matcher（例如 Claude `Notification`）先按完整事件/handler匹配，再按 matcher 归属；无法唯一归属时停止猜测。

多来源结果固定以 `~/.codex/hooks.json` 或 `~/.claude/settings.json` 为首选写入目标，并执行以下只读冲突判断：

- Codex 用户层已有内联 TOML Hook：停止，不能静默新建 `hooks.json`；
- Codex 用户层 JSON 与 TOML 都含 Hook：报告双表示冲突；
- 圆圆 handler 出现在非首选来源：报告所有权位置冲突；
- 圆圆 handler 同时出现在多个来源：报告跨来源重复；
- Claude 项目级只有用户自己的 Hook：允许共存，不计为冲突；
- 任一来源解析失败、超限、来源类型不匹配或集合规格不唯一：人工复核。

返回结果不含命令、路径、owner、连接器 ID、来源实例、`key_id` 或其他配置值。`config_write_performed=false` 与 `source_task_behavior_changed=false` 是固定事实。JSON/JSONC 首选来源现在可报告 `lossless_write_supported=true`，多来源结果可报告 `lossless_edit_supported=true`；这只表示能够在内存中逐字保留旧内容并生成候选差异，不表示已经写入文件。

`yuanyuan-connectors::config_edit` 已实现纯内存无损增加：标准 JSON 与 JSONC 注释先以等长空白参与语义解析，字节位置保持不变；编辑器只在缺失/部分安装且无冲突时，在对应对象或数组边界插入缺失 matcher 组。旧字节不重排、不重编码，生成后必须再次得到“全部 handler 精确一致”才返回候选结果。重复键、TOML、修改/重复/意外圆圆条目、非法或超限输入全部关闭失败；调试输出不包含候选配置正文。该模块不打开路径、不创建备份，也没有落盘 API。

## 6. 内部写入事务与仍关闭的正式入口

设置页现在只在随机稳定连接器实例已授权时显示“只读检查 Hook 配置”。该动作按官方用户级位置读取 Codex 的 `CODEX_HOME/hooks.json`、`CODEX_HOME/config.toml` 或 Claude 的 `%USERPROFILE%/.claude/settings.json`；根目录必须是绝对普通目录，配置文件必须是非重解析点普通文件且不超过 64 KiB。缺失文件按空来源处理，路径异常、超限、解析失败或结构异常全部退回人工复核。返回值只包含固定枚举和数量，不含路径、命令、身份、凭据引用或配置值；项目级配置、会话和任务正文不读取，来源工具不启动，文件不写入。

稳定核心内部现已具备一个不可从 Tauri 命令或设置页调用的写入协调器。它只接受绝对路径下固定文件名 `hooks.json` / `settings.json` 和 JSON/JSONC 格式；预览把目标存在性、原始 SHA-256、Windows 文件身份、内存候选摘要与 handler 数量绑定到两分钟单次令牌。确认执行时先消费令牌，再重读目标并重建候选；内容、文件身份、候选摘要或数量任一变化都会停止。现有文件先在同目录创建当前用户专用的带时间戳备份，再用 Windows 写穿透原子替换；缺失文件使用不覆盖已出现文件的原子移动。临时文件和备份均以创建后捕获的文件身份精确管理，替换后再次核验摘要与身份，失败路径只在确认已安装文件确属本次操作时回滚。返回值仍只有固定状态、数量和是否改变配置等脱敏事实，不含目标路径、配置正文、命令或身份值。

私有官方目标封装现已把授权身份、当前 Bridge 参数集合、官方用户级根目录、多来源冲突预览和底层写入协调器串成单一流程。生产入口只接受 `connector_id + source_instance`，确认入口只接受令牌，不存在路径参数；Codex 的用户级 `hooks.json` 与 `config.toml` 会一起绑定，任一来源在确认期间新增、替换或变化都会停止。该封装仍只由临时目录测试调用，没有 Tauri command、设置页按钮或任何自动执行路径；因此本机 Codex / Claude 配置保持零写入。正式入口仍缺少：

事务状态机、文件身份、失败语义与测试门详见 `HOOK_CONFIG_WRITE_TRANSACTION_V1.md`。

1. Bridge 以签名身份进入安装包并完成升级/回退验证后，才增加展示差异、备份事实与明确确认的 Tauri / 设置页入口；
2. 为已实现的私有断开组合状态机增加用户可见的差异、双模式确认与阶段恢复界面；配置冲突时只开放明确的“仅撤销认证权限”，不得猜测删除被修改的 Hook；
3. 在具备符号链接权限的 Windows 环境补跑真实重解析点矩阵；
4. 完成项目级多配置层显式授权、Codex `/hooks` 信任复核、Claude `/hooks` 只读核验和真实进程级 fail-open 试验。

以上门禁完成前，设置页只提供只读检查，不出现写入、修复或断开 Hook 的按钮。
