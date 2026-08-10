<p align="center">
  <img src="docs/images/icon.png" width="112" alt="圆圆提醒图标">
</p>

<h1 align="center">圆圆提醒</h1>

<p align="center">
  一只会陪你喝水、专注、休息、安排工作，也愿意和你玩一会儿的 Windows 桌面小猫。
</p>

<p align="center">
  <a href="../../releases/latest"><strong>下载最新版本</strong></a>
  · <a href="docs/CUSTOMIZE_YOUR_PET.md">换成自己的宠物</a>
  · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img alt="Version 1.4.0" src="https://img.shields.io/badge/version-1.4.0-bb835c">
  <img alt="Windows 10/11 x64" src="https://img.shields.io/badge/Windows-10%20%2F%2011-5b8fb9">
  <img alt="Code license MIT" src="https://img.shields.io/badge/code-MIT-76a985">
  <img alt="Offline first" src="https://img.shields.io/badge/runtime-offline-8a78a8">
</p>

![圆圆用醒目的大气泡提醒喝水](docs/images/yuanyuan-alert.jpg)

圆圆提醒是一款完全本地运行的桌面宠物与任务提醒工具。安装和日常使用不需要 Codex、Kimi Code、Node.js、Rust、Python、账号或云服务；Coding 工具只在你希望修改代码或把圆圆换成自己的宠物时才会用到。

## 圆圆会陪你做什么

| 你的事情 | 圆圆的配合 |
| --- | --- |
| 喝水提醒 | 弹出醒目的大气泡，用前爪拍“屏幕玻璃”；记录喝水后马上恢复日常状态。 |
| 工作任务 | 提醒一次性、间隔、每日和自选星期事项；可编辑、启停、删除，并支持 5/10/30/60 分钟稍后。 |
| 专注工作 | 乖乖坐着或趴着，不随意走动；专注结束后提醒你休息。 |
| 久坐活动 | 连续使用电脑达到设定时间后，圆圆会开心地上蹦下跳。若与喝水重叠，会先提醒喝水。 |
| 离屏休息 | 可开始 5 或 10 分钟的定时休息，并锁定 Windows；回来解锁后继续使用。 |
| 日常陪伴 | 会舔毛、伸懒腰、打哈欠、喵喵叫、翻肚皮、入睡、呼吸和醒来。 |
| 需要安静陪伴 | 由你主动选择让圆圆靠近、陪你轻轻活动或退开留出空间；只用猫咪动作回应，不判断或记录情绪。 |
| 离开后回来 | 白天确实离开较久后，圆圆会低频起身靠近、轻轻蹭一蹭；没有对白，也不会记录你去了哪里。夜间安静、短暂离开、专注或提醒占用时不触发。 |
| 互动玩耍 | 吃猫粮、喝水、追着猫条吃、左右伸爪抓逗猫棒、蹭鼠标、追球并把球叼回来。 |
| 回顾记录 | 查询已经完成、手动跳过或因过期自动归档的工作、喝水和活动记录。 |
| 数据安全 | 每天自动备份，保留最近 14 份；也可手动备份并在校验后安全恢复。 |

## 今天：喝水和事项放在一起

![今日喝水进度和待处理事项](docs/images/today.jpg)

- 一次性、间隔、每日、每周提醒；
- 完成、5/10/30/60 分钟后提醒、跳过；
- 今日饮水进度；
- 喝水、普通事项、活动提醒采用明确的优先级和排队机制。

## 专注：工作时安静，休息时陪你离屏

![专注和离屏休息](docs/images/focus.jpg)

专注期间圆圆只使用安静的坐姿或趴姿。离屏休息可以锁定 Windows，计时结束后通过系统提示和圆圆动画提醒你回来；Windows 出于安全原因不允许应用绕过密码、PIN 或 Windows Hello 自动解锁。

## 互动：圆圆不是一张会切换的图片

![喂食、摸摸、逗猫棒和扔球游戏](docs/images/care.jpg)

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/images/interaction-food.png" alt="圆圆低头吃猫粮">
      <br><strong>喂猫粮</strong>
      <br><sub>圆圆走近小碗，低下脑袋慢慢吃。</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/images/interaction-water.png" alt="圆圆认真舔水">
      <br><strong>喂水</strong>
      <br><sub>圆圆伏在水碗前，伸出舌头认真喝水。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="docs/images/interaction-treat.png" alt="圆圆站起来追着猫条吃">
      <br><strong>喂猫条</strong>
      <br><sub>眼睛盯着猫条，随鼠标转向，猫条升高时会站起来吃。</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/images/interaction-wand.png" alt="圆圆伸爪抓逗猫棒">
      <br><strong>逗猫棒</strong>
      <br><sub>逗猫棒在哪个方向，圆圆就朝那个方向转头、伸出对应的爪子。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="docs/images/interaction-petting.png" alt="圆圆眯着眼睛蹭手">
      <br><strong>摸摸圆圆</strong>
      <br><sub>鼠标进入头部区域后，圆圆会眯起眼睛，顺着你的手轻轻蹭过去。</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/images/interaction-ball.png" alt="圆圆伸爪扒拉小球">
      <br><strong>扔球游戏</strong>
      <br><sub>追到球后先用爪子扒拉，再叼起球慢慢走回来并放到脚边。</sub>
    </td>
  </tr>
</table>

- 猫条会跟随鼠标，圆圆转头盯住猫条并逐步站起来吃；
- 逗猫棒在左边时伸左爪，在右边时伸右爪，在上方会站起来抓；
- 鼠标进入头部区域时圆圆会轻轻蹭过去，移出后立即停下；
- 扔球时按住蓄力、松手抛出，圆圆会追球、扒拉两下、叼回来并放到脚边；
- 切换互动会正确结束上一项玩具，不会把猫条或球带到下一个场景。

### 陪陪我：听得懂，但不替猫咪说人话

照料页提供三张由你主动打开的陪伴小牌：圆圆可以安静靠近一会、先伸懒腰陪你轻轻活动，或退开并停止主动回看。简单反馈只使用表情和肢体动作，不出现猫咪对白气泡。

这三种陪伴不判断你的情绪，不调用模型，也不保存原因或心情记录；状态只在当前应用内存中运行，到时自动结束，关闭应用后不恢复。喝水、到期工作事项和等待用户仍可优先出现。

## 设置：把提醒节奏交给你

![圆圆提醒设置](docs/images/settings.jpg)

可以设置动画模式与速度、道具标签显示方式、朝向鼠标、置顶与穿透、安静时段、自动入睡、喝水与活动节奏、错过提醒策略、开机启动和提醒暂停。道具标签可选“纯动作 / 需要时显示 / 始终显示”，只贴在任务牌等工具上，不会成为圆圆的对白；默认仅在等待确认、失败、疑似停住或状态不明时显示。管理页支持修改、暂停和删除普通提醒；设置页可以创建、查看和恢复本地备份。

## 下载和使用

在 [Releases](../../releases/latest) 页面选择：

- `Yuanyuan-Reminder-*-x64-Setup.exe`：安装版，适合长期使用；
- `Yuanyuan-Reminder-*-x64-Portable.exe`：便携版，下载后直接运行。

当前支持 Windows 10/11 x64。程序尚未购买商业代码签名证书，Windows SmartScreen 可能显示“未知发布者”。你可以核对 Release 中的 `SHA256SUMS.txt`，也可以从源码自行构建。

应用数据默认保存在：

```text
%LOCALAPPDATA%\com.yuanyuan.reminder\
```

## 用自己的宠物照片制作一个版本

这套工具不仅可以运行圆圆，也可以成为你自己的桌面宠物项目：

1. 准备 3–8 张你有权使用的宠物照片，覆盖正脸、侧脸、全身和标志性花纹；
2. 将仓库和照片交给 Codex、Kimi Code 或其他 Coding 工具，并附上 [AI 定制提示词](AI_CUSTOMIZATION_PROMPT.md)；
3. 按照 [自定义宠物教程](docs/CUSTOMIZE_YOUR_PET.md) 生成、验证动作图集，然后重新构建 Windows 程序。

完整动作和文件格式见 [宠物包规范](docs/PET_PACK_SPEC.md)。生成过程中必须锁定毛色、脸型、眼睛、花纹和体态，不能用一张静态图代替连续动作帧。

## 本地开发

需要：Node.js 20+、Rust stable、Visual C++ Build Tools、WebView2 Runtime。

```powershell
npm.cmd ci
npm.cmd run verify
npm.cmd run ai-off:verify
npm.cmd run tauri dev
```

正式构建：

```powershell
npm.cmd run tauri build
npm.cmd run release:preflight
```

`release:preflight`会生成产物哈希、CycloneDX依赖清单、许可证清单和签名状态报告。它还会在一次性当前用户目录中静默安装并卸载 NSIS，提取真正随安装包落盘的 `NSS` 主程序；便携主程序、NSIS 实际主程序和安装包都会独立进入哈希、签名与安全软件门。随后使用冻结哈希的官方 v1.3.2 Setup 执行 `1.3.2→1.4.0→卸载1.4.0→回装1.3.2` 隔离探测，验证程序身份、四份许可证、正式数据目录合成哨兵和零残留；缺少该历史安装器时可通过 `release:upgrade-rollback -- --HistoricalInstallerPath ...` 显式传入。预检还会自动运行 `release:install-failure-recovery`：确定性损坏候选与旧主程序独占锁验证写入前失败边界；受限 Windows Job 则在观察到部分主程序写入后终止整棵安装器进程树，要求不完整文件集、旧卸载器、许可缺席和数据哨兵均符合预期，随后未修改候选必须完整恢复。默认安装目录证据不会由普通预检重复制造；只能在明确干净的测试账户先运行 `npm.cmd run release:upgrade-rollback:default`，之后预检会按当前候选与脚本哈希复核该报告，并把控制面板注册是否真正可见保留为独立事实。交互式卸载数据选择也不会在普通预检中重复点击；在干净交互账户运行 `npm.cmd run release:uninstall-data-choice` 后，预检会按候选和脚本哈希复核报告，要求默认卸载保留 LocalAppData/RoamingAppData，且只有明确勾选真实 NSIS 复选框才删除两处数据。首次启动写库恢复同样不会由普通预检自动触发；只可在正式数据目录不存在的一次性账户运行 `npm.cmd run release:first-start-recovery`。该探针在观察到非空 SQLite WAL 后终止受限 Job，再以同一候选恢复到可见窗口、架构 11 和完整默认数据；预检会独立重开规范化样本并复算候选、脚本与数据库哈希。上述流程会拒绝已有圆圆默认安装目录、产品注册、快捷方式、启动项、运行进程或正式数据目录。正式构建还会生成逐生产组件的[第三方许可证全文归档](THIRD_PARTY_LICENSES.txt)，并把代码、素材、第三方摘要和全文四份许可材料安装到应用的`licenses`目录。真正发布前使用`npm.cmd run release:gate`；当前产物尚未签名，因此严格门应当阻断，不能把本地构建当成正式发布批准。完整流程见[发布签名、误报与回退SOP](docs/release/P0_RELEASE_SIGNING_AND_FALSE_POSITIVE_SOP.md)、[NSIS 实际安装主程序验收](docs/P0_NSIS_INSTALLED_PAYLOAD_QA_2026-08-09.md)、[安装升级与安全回装旧版隔离探测](docs/P0_RELEASE_UPGRADE_ROLLBACK_PROBE_2026-08-09.md)、[安装失败与恢复隔离验收](docs/P0_RELEASE_INSTALL_FAILURE_RECOVERY_QA_2026-08-09.md)、[首次启动数据库恢复验收](docs/P0_RELEASE_FIRST_START_RECOVERY_QA_2026-08-10.md)、[卸载数据选择验收](docs/P0_RELEASE_UNINSTALL_DATA_CHOICE_QA_2026-08-09.md)和[默认安装路径验收](docs/P0_RELEASE_DEFAULT_INSTALL_PATH_QA_2026-08-09.md)。

许可证人工门不再接受裸布尔值。`release:preflight` 会生成候选绑定的 `release-license-review-packet.json`；发布渠道和精确发布者冻结后，具名人工复核人必须从 `docs/release/RELEASE_LICENSE_REVIEW_ATTESTATION_V1.template.json` 创建实际签字文件，逐项确认地区、NOTICE、回退来源、MPL 源码、素材权利、商标与适用的专业法律复核。`npm.cmd run release:license-review:verify` 会拒绝 AI/自动化签字、候选或渠道漂移、未解决发现及仅修改 `licenseReviewVerified` 的伪通过。当前实际签字文件不存在，因此许可证门继续待完成。

SmartScreen 与第三方安全软件门也不再接受裸布尔值或乐观计数。预检会生成候选绑定的 `release-external-trust-test-packet.json`，冻结三项正式产物、干净机、真实 Internet Zone/Mark-of-the-Web、在线信誉、完整安装生命周期以及至少两款非 Defender 实时防护产品的零检测要求。具名人工测试人须从 `docs/release/RELEASE_EXTERNAL_TRUST_ATTESTATION_V1.template.json` 创建实际签字文件；`npm.cmd run release:external-trust:verify` 会拒绝 AI/自动化测试人、旧候选、无下载来源标记、SmartScreen 警告、Defender 冒充第三方产品、重复产品或任何检测。当前只生成测试包和模板，实际外部测试与签字仍待完成，详见[SmartScreen 与第三方安全软件外部信任门](docs/P0_RELEASE_EXTERNAL_TRUST_QA_2026-08-10.md)。

RFC 3161 门同样不再接受裸布尔值。预检会生成 `release-signing-protocol-packet.json`；最终签名后，具名人工操作人必须从 `docs/release/RELEASE_SIGNING_PROTOCOL_ATTESTATION_V1.template.json` 创建无凭据签字，记录签名工具、三项最终产物、执行证据以及 `/fd SHA256`、`/tr`、`/td SHA256`。`npm.cmd run release:signing-protocol:verify` 还会实时采集Windows Authenticode事实，要求三项产物均为 `Valid`、同证书、发布者精确匹配且都有时间戳证书。当前渠道、Subject和时间戳URL未冻结，实际签字不存在，因此该门继续待完成，详见[签名与RFC 3161协议证据门](docs/P0_RELEASE_SIGNING_PROTOCOL_QA_2026-08-10.md)。

无障碍体验门现已进入严格发布预检。`release-accessibility-acceptance-packet.json` 冻结三项正式候选，并要求最终签名版本完成100%/125%/150%/200% DPI、100%/150%/200%文本缩放、深浅高对比度、减少动态、五条全键盘路径、六条Windows Narrator人工听读路径以及安装/默认保留/显式删除卸载矩阵。具名人工测试人必须从 `docs/release/RELEASE_ACCESSIBILITY_ACCEPTANCE_ATTESTATION_V1.template.json` 创建实际签字；自动截图、DOM/CSS测试、UI Automation、AI测试人或只修改 `accessibilityAcceptanceVerified` 都不能通过。当前实际人工矩阵尚未执行，详见[发布候选无障碍验收门](docs/P0_RELEASE_ACCESSIBILITY_ACCEPTANCE_QA_2026-08-10.md)。

完整升级回退门也不再接受裸布尔值。`release-upgrade-completion-packet.json` 把六个自动子门、默认路径控制面板注册、真实v1.3.2数据库迁移报告、签名/RFC3161候选、物理掉电或虚拟机硬重置、真实Windows重启、安全恢复旧库和具名人工签字绑定为同一合同。当前包明确缺少真实迁移报告与签名协议实际签字，因此 `upgrade_rollback_drill` 保持待完成；现有合成哨兵和受控进程终止不会被冒充成真实中断。详见[完整升级、中断与回退证据门](docs/P0_RELEASE_UPGRADE_COMPLETION_QA_2026-08-10.md)。

`ai-off:verify`是当前默认发行方式的必跑门：确认安装声明不包含Bridge/AI、生产核心没有外部网络入口，并验证AI不存在时提醒和专注仍可使用。`verify`、发布预检和严格发布门均已自动包含该检查。

隔离运行性能烟测：

```powershell
npm.cmd run runtime:qa:build
npm.cmd run runtime:baseline -- -DurationSeconds 60 -SampleIntervalSeconds 2 -WarmupSeconds 10
npm.cmd run runtime:reminder-latency -- -SampleCount 5 -ExitAfterSeconds 30
npm.cmd run runtime:release-cold-start -- -SampleCount 3 -WindowTimeoutSeconds 30 -AcknowledgeFreshTestAccount
```

24小时常驻、睡眠和锁屏严格验收：

```powershell
npm.cmd run runtime:baseline:acceptance
npm.cmd run runtime:baseline:verify -- --report "F:\绝对路径\runtime-baseline-<UTC>.json"
```

验收期间测试人员需在同一Windows会话中至少完成一次真实锁屏/解锁和睡眠/唤醒；执行器不会主动改变系统会话或绕过认证。完整口径见[24小时常驻、睡眠与锁屏验收门](docs/P0_RUNTIME_ENDURANCE_GATE_2026-08-09.md)。

v1.3.2 真实数据库副本的隔离迁移验收：

```powershell
npm.cmd run database:migration:qa -- --fixture "F:\绝对路径\v1.3.2-copy.sqlite3" --report "F:\绝对路径\v1.3.2-migration-report.json" --attest-source-release 1.3.2
```

关闭态旧库仍有 WAL 时，可先用 `npm.cmd run database:migration:capture -- --source ... --fixture ... --report ... --attest-source-release 1.3.2` 通过 SQLite Backup API 生成稳定单文件副本。两个命令都拒绝用合成样本冒充真实来源；迁移报告覆盖逐值保留、备份恢复和失败回滚。GitHub 正式 v1.3.2 发布件已完成版本与双重哈希核对，但在当前隔离普通账户中未进入 `setup`、没有生成数据库，因此真实样本门仍保持开放。执行要求与当前边界见 [v1.3.2 真实数据库迁移验收](docs/P0_V132_DATABASE_MIGRATION_QA_2026-08-06.md)。

任务守望数据库的一年等价保留与增量回收验收：

```powershell
npm.cmd run database:retention:qa -- --report "F:\绝对路径\annual-retention-report.json" --attest-synthetic-profile annual-175200-v1
```

该命令只生成固定合成数据，在随机所有临时目录中运行生产清理与有界增量回收，拒绝相对路径和覆盖已有报告。正式负载口径与结果见[任务事件一年等价负载验收](docs/P0_TASK_RETENTION_LOAD_QA_2026-08-06.md)。

运行基线与提醒延迟使用专用数据根；迁移验收只读操作者显式提供的副本；保留验收只生成合成数据，均不改动正式用户数据库。冷启动命令运行从当前 NSIS 精确提取的实际安装主程序，只允许在正式数据目录完全不存在、且当前令牌/ProfileList与配置目录一致的一次性测试账户中执行；已有数据或仅伪造环境变量时会在启动前拒绝。当前候选已完成3次正向采样，P50/P95为136.4/230.1 ms，运行后零数据与进程残留。详细边界见[默认正式主程序新配置冷启动验收](docs/P0_RELEASE_COLD_START_QA_2026-08-06.md)。短时通过不能替代24小时、睡眠恢复或签名候选结论。

只预览界面：

```powershell
npm.cmd run dev
```

浏览器预览支持 `?window=panel&tab=today|focus|care|history|add|settings` 和 `?window=pet`，不写入真实数据库。

## 项目结构

```text
src/                       React 界面、宠物状态机和交互
src-tauri/                 Rust/Tauri 后端、SQLite、Windows 集成
public/assets/pet/         当前圆圆宠物包
scripts/                   宠物图集构建与验证工具
docs/                      使用、定制和格式说明
.github/workflows/         自动测试和 Windows Release
```

## 隐私

- 提醒、历史、喝水与互动记录只保存在本机 SQLite 数据库；
- 程序不需要登录，不上传任务、照片或使用记录；
- 程序不访问 `.codex`，也不调用任何 AI 服务；
- 自动启动、通知和锁屏均通过本地 Windows 能力完成。

## 参与贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全问题请按照 [SECURITY.md](SECURITY.md) 报告。

程序代码使用 [MIT License](LICENSE)。圆圆照片、图集、图标和演示图片使用单独的 [圆圆素材许可](ASSETS_LICENSE.md)；第三方摘要见[第三方声明](THIRD_PARTY_NOTICES.md)，逐组件全文见[第三方许可证归档](THIRD_PARTY_LICENSES.txt)。如果你发布自己的分支，建议替换成你自己的宠物素材并重新运行许可归档生成器。
