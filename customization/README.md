# 个性化工作流

## 粘贴一段提示词即可（推荐）

新用户可以直接从 GitHub 项目主页复制根目录的 [AI_CUSTOMIZATION_PROMPT.md](../AI_CUSTOMIZATION_PROMPT.md)，替换宠物名和性格，然后把整段提示词与照片一起发给支持参考图生成或编辑、具备本地文件和 Coding 能力的 Kimi Code、WorkBuddy 或 Codex。用户电脑不需要预先存在本项目，也不需要下载源码、运行命令、安装开发依赖、创建 JSON、填写 identifier，或判断品种、性别。

默认摄影写实，用户明确指定其他风格时遵从其选择。流程是提供照片、确认主形象、制作方试做并检查待机/转头/行走后批量制作、最终导入宠物包。主形象须经用户确认，无回复不视为确认；更换已确认形象需重新确认。共用质量要求见[制作方合同](PET_CUSTOMIZATION_AGENT_PROMPT.zh-CN.md)，填写后的[身份锁](../pet-template/identity-lock.template.md)与[验收记录](../pet-template/realism-review.template.md)只放在被忽略的私人工作目录。

Coding 工具必须从 `https://github.com/brucexia007-ui/yuanyuan-reminder` 自行获取完整 Git 工作副本，再读取 `PET_CUSTOMIZATION_AGENT_PROMPT.zh-CN.md`、处理附件并完成后续步骤。

## 智能体内部入口（普通用户不要运行）

### 普通宠物包路线（默认）

在被忽略的工作目录准备有许可的图集后，智能体执行 `npm.cmd run customize:pet -- --source <素材目录> --license <许可文件> --name <宠物名>`。该入口锁定来源与图片哈希、生成独立宠物包，并提供 `--resume <runId>` 恢复校验。它保留圆圆主程序、数据库路径和内置素材，只交付候选包；真实导入、播放和重启验收仍是单独门禁。

### 独立应用旧工具（仅独立工作副本）

以下旧工具为单独应用定制保留，仅在明确要求独立应用、且已配置独立品牌的工作副本中使用；本轮统一主程序不执行其品牌替换，亦不声明独立应用安装交付已验收。普通宠物包任务使用上一节入口。

```powershell
npm.cmd --silent run customize:standalone -- `
  --photos "C:\path\to\pet-photos" `
  --name "糖糖" `
  --personality "安静但好奇"
```

目录只读取第一层的 PNG、JPEG 和 WebP，合计 1–16 张；建议 3–8 张。照片若放在仓库内，必须位于被 Git 忽略的 `work/`。`--silent` 会阻止 npm 回显包含照片路径的执行行；脚本的正常输出也只包含照片计数。命令自动验证图片内容、创建私人请求快照、计算照片哈希、推导独立 Windows 应用标识，并生成品牌草稿、身份锁草稿和三种工具共用的接力合同。Coding 工具随后按照输出的 `resumeCommand` 自动完成素材生成、QA、Windows 验证和打包。维护者可用 `--dry-run` 只验证三个输入且不创建任务。

通用智能体执行约束见 `PET_CUSTOMIZATION_AGENT_PROMPT.zh-CN.md`。用户不需要手工填写品种、性别或风格字段；品种、性别无法可靠判断时保持 `unknown / 由参考照片识别`。旧独立应用请求的 `stylePreset` 继续使用现有合法枚举（默认 `auto`），具体写实要求与用户风格选择记录在身份说明和验收记录中；不要填入未支持的 `photorealistic` 枚举，也不要擅自增加旧 JSON 身份锁的字段。

`pet-request.schema.json` 是统一请求合同；请求中没有普通版/学习版之分。应用始终包含学习能力，但安装包不携带私人知识内容。新请求可在 `pet` 中同时记录 `sex`、`breed` 和 `personality`，恢复流程会把这三项与品牌配置和身份锁交叉核对；旧版 v1 请求仍可读取，避免破坏已经开始的定制任务。

启动一次可恢复任务：

```powershell
npm.cmd run customize:start -- --request customization/pet-request.synthetic.example.json
```

命令会把实际 Git 提交、请求摘要、每一步状态和私人输入清单写到被 Git 忽略的 `work/customization/<run-id>/run-state.json`。继续任务时使用：

```powershell
npm.cmd run customize:resume -- --run-id <run-id>
```

启动命令会同时核对 `origin` 的 HTTPS 仓库身份、请求中 `source.ref` 实际解析的提交与当前 HEAD，三者必须一致。它会把请求快照放到被 Git 忽略的当次 `work/customization/<run-id>/request.json`，状态文件不保留原始外部路径。恢复命令会重新核对锁定的 Git 提交、请求快照哈希与最低产品版本，并只返回下一项未完成步骤。仅查看完整状态可用 `npm.cmd run customize:status -- --run-id <run-id>`。若源码、请求或已记录产物发生漂移，必须修复或重新创建任务，不能沿用旧证据。

每一步完成时，用产物角色与项目内路径记录证据：

```powershell
npm.cmd run customize:complete-step -- `
  --run-id <run-id> `
  --step <customize:resume 返回的 nextStep> `
  --artifact <role=relative\path> `
  --artifact <role=relative\path>
```

命令只允许当前必需步骤，并会原子记录每个非空文件的 SHA-256 与字节数。后续恢复会重新校验所有已记录产物；缺失或改动时会闭合失败，防止跨智能体继续时误用旧证据。`customize:status` 中的 `requiredArtifactRoles` 是当前步骤必须提供的完整清单。

自定义宠物的 `identity_lock` 使用 `customization/pet/identity-lock.template.json`：填写请求中的名称、风格、私人照片数量与哈希、九项视觉身份、至少两条必须保持/避免规则，并把最终主参考 PNG/WebP 作为 `identity_reference` 一并记录。记录只应放在当次被忽略的 `work/customization/<run-id>/`，不得把原始照片路径或照片复制到源码。

`verification` 步骤使用 `npm.cmd run customize:verify -- --run-id <run-id>`。它会依次运行完整 `verify`、Rust 锁定依赖测试和 Tauri 正式构建，并将命令结果、基线提交、定制差异与非忽略新文件的整体快照哈希写入当次忽略目录。完成此步后，用 `npm.cmd run customize:package -- --run-id <run-id>` 复核快照未漂移，再把 NSIS 安装包和 Rust 发行 EXE 复制为具名安装版/便携版，生成 `SHA256SUMS.txt` 与交付清单。两个命令都不会覆盖旧证据。

原始照片和私人学习来源只能留在 `work/` 或用户指定的外部目录，不能复制到 Git、`public/`、Tauri resources、安装包或测试日志。macOS 请求会稳定返回 `PLATFORM_NOT_IMPLEMENTED`；`platforms.json` 对全局鼠标、系统空闲、锁屏/唤醒、登录启动、通知、托盘/菜单栏、透明窗口、置顶、点击穿透、打包、签名与公证全部保留了平台接口，但不宣称已实现 macOS。宠物素材与知识包协议本身保持平台无关。

本节独立应用新定制必须生成视觉 QA 证据（含应用图标检查，不作为普通导入包的必需命令）：

```powershell
npm.cmd run pet:qa -- --output-dir work\customization\<run-id>\pet-qa
```

该命令默认开启新宠物严格模式：标准 11 行、睡眠 3 行、生活 21 行与学习 4 行的每一行都必须有 8 个非空格；五张宠物图、四个 Windows 图标和单独的素材授权文件必须全部不同于官方包指纹。输出包含合并联系表、39 个动画 GIF、16 方向检查表、结构报告、静态回退图/图标/授权绑定和人工语义复核模板。模板中仍有 `pending` 时不得完成 `visual_qa` 步骤。
