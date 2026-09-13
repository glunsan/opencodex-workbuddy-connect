# OpenCodex WorkBuddy Connect

把 **WorkBuddy 国内版 / 国际版**中你自己账号的模型接入 **OpenCodex → Codex**。两区域可以任选一个，也可以同时使用。

Windows 一键安装 · Codex 技能 · 本地桥接 · 零 npm 运行依赖

```text
Codex → OpenCodex → 本机 WorkBuddy Bridge → 你自己的 WorkBuddy 账号
                     ├─ workbuddy-cn/模型名称
                     └─ workbuddy-global/模型名称
```

**使用消耗对应 WorkBuddy 账号的积分。** 国内、国际分别使用各自登录与额度；具体模型、倍率、活动和权限以 WorkBuddy 当时的数据为准。本项目不提供账号、不附带积分。

## 下载

到 [Releases](https://github.com/glunsan/opencodex-workbuddy-connect/releases/latest) 选择：

| 文件 | 适用情况 |
|---|---|
| `opencodex-workbuddy-connect-v1.1.3.zip` | 完整源码 + Windows 安装器 + 技能，推荐大多数朋友使用 |
| `workbuddy-connect-skill-v1.1.3.zip` | 独立 Codex 技能，包含运行源码；让 Codex 帮你完成安装 |

也可以 `git clone https://github.com/glunsan/opencodex-workbuddy-connect.git`。下载项目时使用 **Code → Download ZIP** 同样可用。

## 前置条件

- **Windows 10/11**：本项目的一键安装、登录后后台启动和卸载脚本均面向 Windows。
- **[Node.js 24 或更高版本](https://nodejs.org/en/download)**，安装后重新打开终端。
- **[OpenCodex](https://github.com/lidge-jun/opencodex)** 已安装、完成初始化并在本机运行，默认地址 `http://127.0.0.1:10100`。本次兼容验证基线为 OpenCodex 2.43.0；其他版本的管理接口可能不同。
- 已安装并登录 **WorkBuddy 国内版或国际版**。需要两边模型就分别登录两边。
- Codex 已经通过 OpenCodex 使用模型。

这里不自动安装或替换 OpenCodex，不要求朋友使用作者的账号。没有登录时先在 WorkBuddy 客户端自己完成登录。

## 方法一：双击安装

1. 把完整压缩包解压到一个准备长期保留的目录。
2. 双击 `Install.cmd`。默认识别当前已登录的国内 / 国际区域，并注册对应模型。
3. 在 Codex 模型选择器搜索 `workbuddy`，选择 `workbuddy-cn/...` 或 `workbuddy-global/...`。若已打开的选择器未更新，重新打开 Codex。

安装器只添加自己的来源，不切换默认来源，也不修改 WorkBuddy 桌面登录文件。默认注册当前用户的 Windows 后台任务，登录后隐藏启动；桥接意外退出时自动恢复。任务由 Windows 托管，不依赖安装终端或 Codex 会话保持运行。启用自动启动时，每分钟检查一次任务是否需要重新运行；进程整体被外部终止后通常在约一分钟内恢复，健康运行时不重复启动。若 Windows 只停止了托管进程，恢复时会核验并清理本安装遗留的子进程，避免端口冲突。

**安装后请保留项目目录的位置。** Windows 后台任务指向此目录。移动或删除前请先卸载。

终端安装可选择区域、端口或关闭自动启动：

```powershell
# 只接国内 / 只接国际 / 同时接两边
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install.ps1 -Region cn
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install.ps1 -Region global
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install.ps1 -Region both

# 首次安装时换一个空闲端口，或不设置 Windows 登录后启动
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install.ps1 -Port 10109 -NoAutoStart
```

## 方法二：作为 Codex 技能

完整项目包含 `skills/workbuddy-connect`，技能中已打包桥接源码，不需要再次下载仓库。

- **完整包**：双击 `Install-Skill.cmd`，只安装技能；它不会立即连接 WorkBuddy 或修改模型来源。
- **独立技能 ZIP**：解压后把整个 `workbuddy-connect` 文件夹放到 `$CODEX_HOME/skills/`；未设置 `CODEX_HOME` 时放到用户目录的 `.codex/skills/`。不要只复制 `SKILL.md`。

重新打开 Codex，然后发送：

```text
用 $workbuddy-connect 帮我把本机登录的 WorkBuddy 接入 OpenCodex。
```

也可以说“只接国内版”“只接国际版”“检查 WorkBuddy 连接状态”“刷新 WorkBuddy 模型”或“卸载 WorkBuddy 接入”。技能会检查环境、使用本机账号，并保留现有配置。

技能包不是账号或模型本身；真正调用仍由本地桥接完成。自动选择机制按账号当时可用的模型目录工作，不硬编码作者的模型数量。

## 日常使用

```powershell
node src/cli.ts accounts
node src/cli.ts status
node src/cli.ts models --region cn
node src/cli.ts models --region global
node src/cli.ts install
```

`accounts` 在首次安装前也能只读检查桌面登录；`status` 检查已运行的桥接。`install` 可以重复运行以同步可用模型、上下文窗口、图像输入和上游声明的推理档位。模型列表缓存最长 5 分钟。不会发送推理请求；模型来源仍是你的账号。

只在需要实际测试时运行以下命令；这会调用模型，可能消耗积分。把 `MODEL_ID` 换成上一条 models 返回的 ID：

```powershell
node src/cli.ts smoke --region cn --model MODEL_ID
```

本地 API 支持：

- `GET /healthz`、`GET /status`
- `GET /cn/v1/models`、`POST /cn/v1/chat/completions`
- `GET /global/v1/models`、`POST /global/v1/chat/completions`

所有接口均需要桥接本地 Bearer 密钥；安装器自动配置。无需手工粘贴 WorkBuddy token。

## 登录、数据与权限

Windows 默认只读以下文件（优先 Local AppData，找不到时查 Roaming）：

| 区域 | 相对 AppData 的登录文件 |
|---|---|
| 国内版 | `CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |
| 国际版 | `CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info` |

自定义位置用 `WORKBUDDY_CN_AUTH_FILE` 和 `WORKBUDDY_GLOBAL_AUTH_FILE`。任务运行日志为状态目录内的 `bridge-supervisor.log`。桥接运行状态默认在 `%USERPROFILE%\.opencodex\workbuddy-connect`，可以用 `WORKBUDDY_BRIDGE_HOME` 或 CLI `--state-dir` 自定义；PowerShell 安装器可传 `-StateDir`。

- 桥接绑定 `127.0.0.1`，校验 Bearer、Host 和浏览器 Origin。
- 对话内容与 access token 只发给对应 WorkBuddy 服务。refresh token 只用于刷新接口。
- 区域、账号和企业身份隔离；退出或切换桌面账号后不会复用旧账号缓存。
- 刷新缓存仅写在桥接自己的状态目录，不覆盖桌面登录文件。
- 安装通过 OpenCodex 本地管理 API 添加来源；其管理密钥只在本地读取和使用。
- 运行目录含私密数据，**不要打包给别人或提交 Git**。本仓库、技能和发布压缩包不含作者的凭据。

## 常见问题

**只有国内版，没有国际版，可以安装吗？** 可以。默认只注册检测到登录的区域；之后登录另一区域再运行安装即可。

**提示 OpenCodex 不可用？** 先使用 `ocx status` 检查并按 OpenCodex 文档启动。若管理端口不是 10100，CLI 安装支持 `--opencodex-url http://127.0.0.1:实际端口`。不要把管理接口改为公网地址。

**端口占用？** 首次安装可传 `-Port`。若已有桥接在运行，不要启动第二份副本；使用它原来的项目目录更新或先卸载。不要随意杀掉其他服务。

**WorkBuddy 401 或登录过期？** 打开对应区域的 WorkBuddy 重新登录，再重试状态 / 安装。不要把 token 发给别人排障。

**模型存在但调用失败？** 目录可见不代表每个模型都已验证。检查自己账号的权限、积分和网络；服务端限流或更新也可能导致失败。

**可以直接装到原版 Codex、跳过 OpenCodex 吗？** 本项目的接入路线是通过 OpenCodex。桥接提供 Chat Completions，由 OpenCodex 适配为 Codex 使用的 Responses 接口。

**macOS / Linux 能用吗？** Node 核心保留相应登录文件探测，但此发布仅完成 Windows 验证。其他平台可手动运行 `node src/cli.ts serve` 与 `install`，后台服务需自行配置，尚未提供一键安装保证。

## 卸载

保持 OpenCodex 运行，双击 `Uninstall.cmd`。它移除自己的模型来源和 Windows 后台任务，并停止本桥接，保留原有来源和 WorkBuddy 登录。运行状态目录保留供恢复。

如果把 WorkBuddy 设成 OpenCodex 的默认来源，先切换默认来源再卸载。为防止误停其他安装，遇到路径或来源冲突会停止并提示。

删除技能只需移除安装的 `workbuddy-connect` 技能目录；已经运行的桥接需先执行上述卸载。

## 验证与维护

以下开发命令在完整源码仓库中执行；独立技能内的 `assets/bridge` 只作为运行与安装包。

```powershell
npm test
npm run build:skill
npm run check:skill
```

Windows 后台托管回归检查（创建独立测试任务，结束时移除；不会调用模型或修改 OpenCodex 来源）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/bridge-task.integration.ps1
```

它验证模型子进程及整个后台任务被终止后的自动恢复、已有自定义端口保留，以及 `-NoAutoStart` 不被手动启动改变。v1.1.3 修复了旧版后台进程被整体终止后缺少再次触发、导致 OpenCodex 502 的问题。禁用自动启动时不会添加定时恢复触发器；完整卸载会先禁用任务，再停止并移除，避免卸载时被重新拉起。

`build:skill` 将允许发布的运行文件同步至技能 `assets/bridge`。CI 在 Windows 和 Linux / Node.js 24 上运行本地测试与技能副本一致性检查，不访问真实 WorkBuddy 账号。

初版在 Windows 上完成两个代表模型的真实文本、流式响应、Responses 接口和工具调用往返验证；没有对所有账号、所有模型、图像输入或 Windows 重启进行全面验证。

## 来源与许可

基于 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) 改编，保留 MIT 许可证和原作者署名。本版本移除 DSH 运行依赖，增加 OpenCodex 接入、双区域登录与技能分发，并修正国际模型目录与首条系统消息要求。详细来源见 [NOTICE.md](NOTICE.md)。

使用 WorkBuddy 客户端接口，非官方开放 API。WorkBuddy 或 OpenCodex 更新后可能需要适配；本项目与腾讯、WorkBuddy、OpenAI、DeepSeek 无官方关联。请遵守对应服务条款，仅使用自己有权使用的账号和额度。
