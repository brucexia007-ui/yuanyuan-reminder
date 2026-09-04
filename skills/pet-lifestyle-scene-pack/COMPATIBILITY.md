# 平台兼容与分发

版本：`1.1.0`

核心 `SKILL.md` 遵循 Agent Skills 的通用目录形式。平台之间只适配发现路径、调用语法、元数据和图像工具名称；身份锁定、性格映射、场景卡、参考图和质量门槛保持一份来源。

## Codex

- 使用本目录作为项目级或用户级 Skill。
- 显式调用：`$pet-lifestyle-scene-pack`。
- `agents/openai.yaml` 提供 Codex UI 元数据和自动触发策略。
- 使用 `view_image` 和内置 ImageGen 完成看图、生成和修图。

## Kimi Code

- 将本目录放入 `~/.kimi/skills/pet-lifestyle-scene-pack/`，或使用 `--skills-dir` 指向包含本 Skill 的目录。
- 显式调用：`/skill:pet-lifestyle-scene-pack`；也可由 Kimi 根据 description 自动触发。
- Kimi 会忽略 Codex 专用的 `agents/openai.yaml`，核心 `SKILL.md`、`references/`、`scripts/` 和 `assets/` 可直接复用。
- 官方说明：https://www.kimi.ai/help/features/use-skills-in-code

## Claude Code

- 将本目录放入 `~/.claude/skills/pet-lifestyle-scene-pack/`，或项目的 `.claude/skills/pet-lifestyle-scene-pack/`。
- 显式调用：`/pet-lifestyle-scene-pack`；description 允许 Claude 自动发现。
- Claude Code 会忽略 `agents/openai.yaml`，其余通用内容直接复用。生成图片时映射到当前 Claude 环境实际提供的图像工具；没有生图能力时不能伪造结果。
- 官方说明：https://code.claude.com/docs/en/slash-commands

## WorkBuddy

- 使用 `compat/workbuddy/SKILL.md` 作为平台入口；它包含 WorkBuddy 要求的中英文描述、版本和作者字段。
- 运行 `scripts/build_distribution_packages.py --output-dir <目录>` 可生成 WorkBuddy 可上传 ZIP。
- WorkBuddy 包把场景图片放入 `references/reference-scenes/`，并使用 `@references/...` 引用平台可加载的补充内容。
- 官方说明：https://open.workbuddy.cn/docs/skill

## 豆包

当前不维护豆包专用安装包。若豆包会话能够读取 GitHub 文件并调用图像生成，可直接粘贴 `START_HERE.zh-CN.md` 中的提示词做尽力兼容；否则需要另行制作豆包智能体或工作流，不宣称原生兼容。

## 分发包

打包脚本生成两个包，避免重复维护十三张参考图：

- `pet-lifestyle-scene-pack-universal-v1.1.0.zip`：Codex、Kimi Code、Claude Code。
- `pet-lifestyle-scene-pack-workbuddy-v1.1.0.zip`：WorkBuddy 专用 Frontmatter 与资源布局。
- `SHA256SUMS.txt`：两个 ZIP 的 SHA-256。

生成物写入调用者明确指定的目录，不提交到源码仓库。
