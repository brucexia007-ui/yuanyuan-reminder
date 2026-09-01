# GEN-000 本地通用知识包 v1 工程合同

状态：工程协议已冻结；正式发布仍需社区稳定验收与具名人工复核
生效日期：2026-08-28
范围：统一产品 1.5.5+，本地、声明式、无账号、无网络、无运行时 AI 依赖

## 1. 产品边界

- 统一应用始终包含学习能力，自动邀请默认关闭，安装包与公开 Release 不携带私人知识内容。
- 应用只直接导入 UTF-8 JSON/CSV；PDF、Word、Markdown、TXT、表格和网页由用户选择的智能体在应用外整理。
- 知识包不是课程背书。应用记录用户的来源和权利声明，但不替用户作出版权法律结论。
- 私人包位于 `work/personal-learning/<run-id>/` 或用户选择的本机目录，不进入 Git、`public/`、Tauri resources、安装包、Release 或测试日志。

## 2. 稳定身份和题型

公开 Schema 为 `customization/learning/learning-pack.schema.json`。

`customization/learning/interop-fixtures/` 固化了 Codex、Kimi 和 WorkBuddy 三种输出形态的合成合规样例（完整选择题、BOM/Unicode recall、CRLF/精简可选字段）。Node 制包验证器与 Rust 正式导入适配器共同读取这三个夹具；这是协议互操作回归，不代替对外部智能体实际输出的人工内容核对。

- `packId` 与 `cardId` 仅允许 `[A-Za-z0-9._:-]`，长度 1—128。
- 题型只有 `recall` 和 `choice`。
- `choice` 必须有 2—4 个互不相同的选项，且正确答案恰好出现一次；无法保证干扰项无歧义时必须改为 `recall`。
- 内部卡片身份为 `SHA-256("yuanyuan-item-v1\0" + packId + "\0" + cardId)`。
- 内容哈希为排除根级 `contentSha256` 后，对所有对象键按 Unicode 码点排序、数组保持原顺序、无额外空白的 JSON 字节计算小写 SHA-256。
- 为保证 JavaScript 制包工具与 Rust 正式导入器逐字节一致，`extensions.payload` 中的数值只允许 `[-9007199254740991, 9007199254740991]` 内的整数，并拒绝负零；扩展命名空间仍只允许 ASCII 协议名，payload 对象键按 Unicode 码点排序。
- 每张卡另外计算题干、答案和完整内容 SHA-256；`scheduleEpoch` 从 1 开始，只能在发布者明确要求重置学习进度时增长。

## 3. 来源与权利

`rights.basis` 只能是：

```text
self_authored
public_domain
open_license
authorized
personal_use_only
unknown
```

- `unknown` 阻止最终包生成和应用确认导入。
- `personal_use_only` 允许本机导入，但必须令 `redistributable=false`，阻止公开分发流程。
- 每张卡至少引用一个已声明的 `sourceRef`；未知引用整包拒绝。
- URL 只作为来源说明文本，不触发网络请求或资源下载。

## 4. 安全预算

| 项目 | 上限 |
| --- | --- |
| 文件 | 25 MiB |
| 单包卡片 | 20,000 |
| JSON 深度 | 8 |
| 同时待确认预览 | 8 |
| preview token | 600 秒、单次消费 |
| prompt | 2,000 Unicode 字符 |
| answer | 4,000 Unicode 字符 |
| explanation | 8,000 Unicode 字符 |
| choice 单项 | 1,000 Unicode 字符 |
| tags | 32 个，每个 64 字符 |
| 单卡 extensions | 16 KiB UTF-8 |

NUL、Unicode 双向覆盖/隔离控制符、CSV 公式前缀、未知字段、重复规范身份、脚本、宏、模板执行、远程资源、绝对路径和父目录资源均关闭失败。

## 5. 预览、确认和原子发布

1. 后台读取并绑定普通文件身份、字节数和 SHA-256。
2. 按固定检查点报告读取、解码、结构、逐卡校验和 staging 进度；用户可取消。
3. 预览令牌绑定文件 SHA-256、解析器版本、Schema 版本、规范化预览摘要和过期时间。
4. 确认时重新读取文件身份。替换、过期或重放必须重新预览。
5. 全量写入同一应用数据根内的 staging，执行 `integrity_check` 和 `foreign_key_check`。
6. 在一个立即事务内把新包切换为 ready；事务提交前旧 ready 包和旧进度保持可用。
7. 解析、staging、校验、取消或提交失败时移除 staging，旧知识和进度不变。

## 6. 同包更新

导入前必须展示新增、变化、停用和预计重置数量：

- `cardId` 相同且题干/答案/epoch 均未变化：完整保留进度。
- 新 `cardId`：进入新卡队列。
- 答案哈希变化或 `scheduleEpoch` 增长：仅重置该卡排程；历史复习日志保持 append-only。
- 仅题干变化：标记变化并保留进度；用户在确认前可见。
- 旧版本存在、新版本缺失：先标记停用，不级联删除历史。
- 新版本 ready 前旧版本继续 ready；不提供远程更新或自动下载。

## 7. 平台与互操作

知识包协议平台无关。当前应用只实现 `windows-x64`；`macos-arm64` 和 `macos-x64` 返回 `PLATFORM_NOT_IMPLEMENTED`。Codex、Kimi 和 WorkBuddy 生成的包使用同一 Schema、验证器和报告格式，不允许工具私有字段绕过 `extensions`。

## 8. 发布门

本文件冻结工程行为，不代替：24 小时常驻、真实安装后 E2E、v1.3.2 数据升级、20,000 卡正式候选复测、具名无障碍/安全/内容复核、`release:community:gate`、合并 `main` 或实际最终稳定版本标签。任何未完成项必须在社区验收文件中保持 pending，禁止自动化代签。
