# 精选记忆生命周期 v1

状态：P0 冻结草案；本协议对象由数据库 v2 引入，当前 AI 数据库版本为 `3`。

本协议描述长期记忆如何成为可信、可解释、可撤回的数据，不包含对话原文、技能步骤或 Provider 凭据。实现位于 `src-tauri/crates/yuanyuan-ai/src/memory_store.rs`，迁移位于 `migrations/002_memory_lifecycle.sql`。

## 类型与状态

记忆类型为用户偏好、习惯规则、事件和工作上下文。程序性技能必须进入独立技能系统，不能伪装成事实记忆。

每条记录同时保存：

- 来源：`user_asserted`、`user_confirmed`、`system_observed`、`model_inferred`、`untrusted_external`；
- 可信度：`high`、`medium`、`low`、`unknown`；
- 敏感级别：`public`、`personal`、`sensitive`、`restricted`；
- 生命周期：`draft`、`active`、`superseded`、`expired`；
- 审核状态：`pending`、`confirmed`、`rejected`；
- 来源引用、是否允许提供给云模型、有效期和创建/确认/更新时间。

`restricted` 内容不能标记为允许发送云端。模型推断的 `sensitive/restricted` 内容不能持久化；外部内容草稿必须带不可信来源引用。

## 信任转换

- 用户明确说“记住”可创建 `user_asserted + active + confirmed` 记录；
- 模型推断、系统观察和外部内容只能创建待审核草稿，不进入正式 FTS，也不能形成高置信事实；
- 用户采纳草稿时创建新的 `user_confirmed` 记录，原草稿和原始来源不改写，通过 `derived_from` 保留生成链；
- 即使恢复或导入的数据把低信任来源错误标成 `active/high`，检索与事实资格查询仍按来源关闭失败；
- 低信任外部值不能成为工具参数或写操作的唯一依据，执行前必须从可信业务状态重新取值。

## 冲突、过期与检索

- 未解决冲突使用 `conflicts_with` 关系，冲突双方立即退出 FTS 和高置信事实生成；
- 用户解决冲突后，失败方进入 `superseded`，胜出方重新进入检索，并建立 `supersedes` 关系；
- 到期记录转为 `expired` 并从索引移除，正文继续作为本地审核历史；
- 正式检索仅返回未过期、已确认、来源为 `user_asserted/user_confirmed` 且无冲突的记录；
- 每次实际使用通过 `memory_retrievals` 记录关联 ID、记忆 ID、用途和时间，不复制正文；任一不合格条目会令整批审计写入回滚。

## 彻底删除与旧备份

“彻底删除”在一个 `BEGIN IMMEDIATE` 事务中完成：

1. 计算 `derived_from`、`duplicates`、`supersedes` 组成的相关谱系；
2. 删除谱系正文、FTS 条目、检索审计和关系；
3. 为每个被删除身份写入只含 SHA-256 摘要、删除时间和保留期的墓碑；
4. 任一墓碑写入失败时回滚全部删除副作用。

`conflicts_with` 不属于派生谱系，因此删除一条记忆不会误删只是与它冲突的另一条事实。

恢复旧备份必须在临时数据库中完成。当前数据库的墓碑先导出并应用到临时恢复候选，墓碑身份优先于旧正文；应用完成、完整性检查和用户确认前不能替换当前 AI 数据库。当前删除历史不可读时，产品不能静默执行自动恢复。

## 当前边界

当前完成数据层和自动化验证，尚未完成记忆中心 UI、正式导入器、云上下文选择、备份加密和跨设备合并。AI 数据库仍不进入 v1.4 提醒自动备份，也未加入正式安装包。
