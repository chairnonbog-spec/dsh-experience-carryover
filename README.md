# 项目经验继承（dsh-experience-carryover）

[![npm](https://img.shields.io/npm/v/dsh-experience-carryover.svg)](https://www.npmjs.com/package/dsh-experience-carryover)
[![license](https://img.shields.io/npm/l/dsh-experience-carryover.svg)](LICENSE)

> **安装**：`dsh plugin add dsh-experience-carryover`
> 或在 DSH 的 **Plugins** → **Add plugin** 中填入包名。装完重启 DSH。

让 DSH 在同一项目的多次对话之间继承经验：会话开始读一次项目根目录的经验文件，交付后把可复用的做法写回文件，并把生成文件按固定结构整理进项目根下的四个归属目录。

## 它怎么工作

经验分**两层**，各自独立存放：

| 层 | 位置 | 放什么 |
|---|---|---|
| **全局** | `$DSH_HOME/experience.md`（通常是 `~/.dsh/experience.md`） | 跨项目通用的心得：DSH 本身用法、插件写法、环境坑 |
| **项目** | `<项目根>/experience.md` | 本项目专有的经验 |

| 时机 | 行为 |
|---|---|
| 对话开始的第一步 | 检查本会话是否已载入；已载入跳过，未载入则**两层都读**并注入一次，写入会话记录 |
| 会话恢复 / 分叉 / 重放 | 注入消息已在会话记录中，判定为“已读”，不会二次注入 |
| 项目交付后 | agent 调用 `save_experience` 追加条目，用 `scope` 选择写哪一层（默认 project） |
| 需要全文或检索 | agent 调用 `read_experience`，`scope` 可为 `all`（默认）/ `project` / `global`，可带 `query` |
| 开始产生文件前 | agent 调用 `project_workspace` 在项目根下建好整理结构 |

插件的常驻提示（system prompt 章节）告诉 agent 这套结构、每个目录放什么、交付后记录经验。插件自身不发起模型请求。

## 项目根下的整理结构

`project_workspace` 在**项目根目录**下建立这套结构，并返回每个目录的角色与当前内容：

```
<项目根>/
├── 运行工具/          ← 脚本等运行工具，直接放这一层，不再细分
├── 下载文件/          ← 从网上或外部取得、尚未整理的文件
├── 项目文件/
│   ├── 交付物/        ← 最终要交给用户或别的系统的成果
│   └── 运行文件/      ← 跑程序实际用到的配置、数据、中间产物
└── experience.md      ← 跨会话经验库
```

归属规则：

- **运行工具**：可执行的脚本、工具封装，扁平存放，不建子目录。
- **下载文件**：外部取得的原始文件，属于“还没整理”的中转区。
- **项目文件/交付物**：成品，交付时用户实际拿走的东西。
- **项目文件/运行文件**：支撑运行的东西，不是成品本身。

## 项目根怎么判定

从会话工作目录向上找最近的、包含项目标记（默认 `.git`）的目录；找不到标记时使用工作目录本身。

## 配置

在该 bundle 的 loader 行 config 中覆盖：

| 字段 | 默认 | 含义 |
|---|---|---|
| `experienceFile` | `experience.md` | 项目根下的经验文件名 |
| `globalExperienceFile` | `experience.md` | `$DSH_HOME` 下的全局经验文件名；设为 `''` 可**关闭全局层** |
| `projectRootMarkers` | `['.git']` | 标记项目根的目录/文件名 |
| `maxInjectBytes` | `32768` | 单次注入上限，**两层各分一半**；超出截断并提示改用 `read_experience` |
| `maxReadBytes` | `262144` | `read_experience` 单次返回上限 |
| `guidance` | `true` | 是否注册常驻提示章节 |
| `guidanceOrder` | `640` | 该章节在 system prompt 中的顺序 |
| `layout.tools` | `运行工具` | 运行工具目录名 |
| `layout.downloads` | `下载文件` | 下载文件目录名 |
| `layout.project` | `项目文件` | 项目文件目录名 |
| `layout.deliverables` | `交付物` | 项目文件下的交付物目录名 |
| `layout.runtime` | `运行文件` | 项目文件下的运行文件目录名 |

目录名必须是单层名字：含 `/`、`\`、`.`、`..` 的值会被忽略并回退默认。

## 文件与数据

- `<项目根>/experience.md`：经验库，纯 Markdown，可直接编辑或用 git 管理。
- `<项目根>/运行工具/`、`<项目根>/下载文件/`、`<项目根>/项目文件/{交付物,运行文件}/`：上述整理结构。
- 插件不保存凭据，不联网，不改动会话日志以外的任何状态。

## 关闭后

移除该 bundle 后，已注入的经验消息仍留在历史会话中，但新会话不再自动读取经验文件，`save_experience` / `read_experience` / `project_workspace` 三个工具也不再可用；`experience.md` 与已建好的目录保持原样。

## 关于跨端继承

**DSH 本身没有账号级云存储**，经验文件不会随账号自动同步到其他设备。官方账号设置明确写着"Completion does not synchronize across devices or create a per-account history"，storage 家族也只有一个本地 JSON 后端。

目前能做的是：**在一台机器上跨项目复用**（全局层）。如果想跨设备，需要自己把经验文件放进你已有的同步渠道（Git 仓库、同步盘等），本插件不绑定任何云服务，也不保存凭据。

## 已知限制

- 只读取一次：会话中途手工修改经验文件不会刷新上下文，需要时用 `read_experience`。
- 结构建在项目根：切换工作目录后按新目录判定项目根，两处结构互不影响。
- `project_workspace` 只建目录不搬文件：已有文件需要 agent 按规则自行归位。
- 经验写入是追加式的模板生成 Markdown，不做语义合并；重复条目按标题加摘要前缀判重。
- 全局层路径依赖 `$DSH_HOME`；解析不到时全局层自动停用，只注入项目层。
