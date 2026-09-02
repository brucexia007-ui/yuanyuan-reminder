# 用自己的宠物制作桌面提醒工具

本教程适用于 Codex、Kimi Code 和其他能够读写本地项目的 Coding 工具。最终 Windows 程序完全独立运行，不需要保留 Coding 工具。

## 最简单的开始方式

新用户无需先下载本项目。打开 GitHub 上的 [一段提示词制作自己的桌面宠物](https://github.com/brucexia007-ui/yuanyuan-reminder/blob/main/AI_CUSTOMIZATION_PROMPT.md)，只替换其中的宠物名和性格，再把整段提示词和 3–8 张照片一起发给具备本地文件和 Coding 能力的 Kimi Code、WorkBuddy 或 Codex。

这就是普通用户需要完成的全部操作。不要自行下载或解压项目、运行命令、安装开发依赖、编辑 JSON 或填写 Windows identifier；Coding 工具会从官方 GitHub 仓库获取源码、准备环境、处理附件、从照片推断品种与性别、生成独立应用标识，并持续完成动作素材、质量检查和 Windows 打包。

照片应只作为当前消息附件提供。Coding 工具如需整理附件，会将其放入被 Git 忽略的 `work/`，不会把原始照片、私人路径或家庭环境信息提交到 Git、公开目录、安装包或日志。后续章节是 Coding 工具必须自动执行的质量要求，普通用户无需手工操作。

## 准备照片

建议提供 3–8 张清晰照片：

- 正脸和左右侧脸；
- 自然站立或坐姿的全身照；
- 能看清眼睛颜色、鼻子、耳朵和毛色的近照；
- 能看清背部、尾巴及标志性花纹的照片；
- 如果体态特殊，再补充俯视或趴卧照片。

照片最好光线自然、不过度美颜、没有衣服遮挡主体。只提供你有权使用的图片；公开仓库不应提交家庭环境、定位信息或含有他人的原始照片。

## 第一步：建立身份锁定说明

复制 `pet-template/identity-lock.template.md`，写清：

- 宠物名称和品种；
- 主毛色、渐层和花纹分布；
- 脸型、眼睛颜色、耳朵和鼻子的形状；
- 身体胖瘦、四肢长度和尾巴；
- 必须保留与必须避免的特征。

这份说明是所有动作生成的视觉来源。任何一行发生品种、脸型、眼睛、毛色或体态漂移，都必须重做完整动作行。

## 第二步：生成标准 8×11 图集

按照 [宠物包规范](PET_PACK_SPEC.md) 生成 9 行标准动作和 16 个注视方向。如果 Coding 环境提供 `hatch-pet` 能力，应优先使用它来准备、生成、验证和打包标准 v2 图集。

关键要求：

- 先确定一张完整、稳定的主形象，再生成动作；
- 每个动作行一次生成完整的连续帧；
- 向左移动只能在视觉上适合镜像时由向右行确定性镜像；
- 注视方向先确认上、右、下、左四个主方向，再插值完整 16 个方向；
- 最终标准图集必须是 `1536 × 2288` 的透明 WebP。

将结果保存为：

```text
public/assets/pet/spritesheet.webp
```

## 第三步：补齐睡眠和扩展互动

圆圆提醒还需要睡眠 3 行、生活互动 21 行。每行生成一张含 8 个连续动作的横向素材，再用项目脚本装配。

睡眠图集：

```powershell
python scripts/build_sleep_atlas.py `
  --enter path\to\sleep-enter.png `
  --loop path\to\sleep-loop.png `
  --output public\assets\pet\sleep-atlas.webp `
  --validation work\pet-qa\sleep-validation.json `
  --preview-dir work\pet-qa\sleep-previews
```

生活图集需要为 [21 个动作行](PET_PACK_SPEC.md#4-生活与互动图集-life-atlaswebp) 分别提供输入。查看完整参数：

```powershell
python scripts/build_life_atlas.py --help
```

这些脚本需要 Pillow 和 NumPy：

```powershell
python -m pip install -r requirements-pet-tools.txt
```

## 第四步：更新名称、图标和应用身份

至少修改：

- `src-tauri/tauri.conf.json` 中的 `productName`、窗口标题和 `identifier`；
- `src-tauri/Cargo.toml` 中的包描述与作者；
- `package.json` 中的名称和描述；
- `README.md`、应用内文字和宠物显示名称；
- `src-tauri/icons/` 中的 Windows 图标。

`identifier` 必须唯一，例如 `com.yourname.yourpetreminder`。更改它会使用新的本地数据目录，避免与圆圆提醒共用数据库。

## 第五步：验证

```powershell
npm.cmd ci
npm.cmd run verify
cd src-tauri
cargo test
cd ..
npm.cmd run tauri build
```

还要人工检查：

- 100%、125%、150% 缩放；
- 单屏和多屏；
- 喝水、活动和普通事项重叠；
- 专注状态是否保持安静；
- 猫条视线、左右逗猫、摸头区域和扔球完整流程；
- 睡眠进入、循环和唤醒；
- 提醒气泡不遮住宠物脸。

## 第六步：发布自己的版本

1. 移除圆圆素材并加入你自己的素材许可；
2. 修改应用名称、图标和 Windows 标识符；
3. 更新版本号和 `CHANGELOG.md`；
4. 推送 `vX.Y.Z` 标签，由 GitHub Actions 生成安装版、便携版和 SHA-256；
5. 在 Release 中说明这是独立分支，不是圆圆提醒官方版本。

可以直接使用仓库根目录的 [AI_CUSTOMIZATION_PROMPT.md](../AI_CUSTOMIZATION_PROMPT.md) 启动一次完整的 Coding 工具任务。
