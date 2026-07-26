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
  <img alt="Version 1.3.0" src="https://img.shields.io/badge/version-1.3.0-bb835c">
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
| 工作任务 | 提醒一次性、间隔、每日和每周事项；完成、稍后或跳过时给出对应反馈。 |
| 专注工作 | 乖乖坐着或趴着，不随意走动；专注结束后提醒你休息。 |
| 久坐活动 | 连续使用电脑达到设定时间后，圆圆会开心地上蹦下跳。若与喝水重叠，会先提醒喝水。 |
| 离屏休息 | 可开始 5 或 10 分钟的定时休息，并锁定 Windows；回来解锁后继续使用。 |
| 日常陪伴 | 会舔毛、伸懒腰、打哈欠、喵喵叫、翻肚皮、入睡、呼吸和醒来。 |
| 互动玩耍 | 吃猫粮、喝水、追着猫条吃、左右伸爪抓逗猫棒、蹭鼠标、追球并把球叼回来。 |
| 回顾记录 | 查询已经完成或跳过的工作、喝水和活动记录。 |

## 今天：喝水和事项放在一起

![今日喝水进度和待处理事项](docs/images/today.jpg)

- 一次性、间隔、每日、每周提醒；
- 完成、10 分钟后提醒、跳过；
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

## 设置：把提醒节奏交给你

![圆圆提醒设置](docs/images/settings.jpg)

可以设置动画模式与速度、朝向鼠标、置顶与穿透、安静时段、自动入睡、喝水时段、喝水间隔、活动时段、活动间隔、开机启动和提醒暂停。

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
npm.cmd run tauri dev
```

正式构建：

```powershell
npm.cmd run tauri build
```

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

程序代码使用 [MIT License](LICENSE)。圆圆照片、图集、图标和演示图片使用单独的 [圆圆素材许可](ASSETS_LICENSE.md)；如果你发布自己的分支，建议替换成你自己的宠物素材。
