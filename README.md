# codex-wecom · 企微 Codex

从企业微信私聊或群聊给 macOS 或 Windows 上的 Codex 派任务、续接对话和接收结果。桌面端插件提供设置弹窗和会话历史，也可以把本机 Codex 的任务结束提醒发到企微。安装时会配置当前用户的后台服务，通过长连接收消息。

## 快速开始

准备 macOS 或原生 Windows、Node.js 22.19 或更新版本（含 npm），以及已登录的 Codex CLI。设置弹窗和会话历史需要 Codex 桌面端。Windows 用户在 PowerShell 中确认 `node --version` 和 `codex --version` 可用。如果还没有 Codex CLI，可以用 `npm install -g @openai/codex` 安装，再运行 `codex login`。

1. 在企业微信创建智能机器人，选择「API 模式 → 使用长连接」，取得 Bot ID 和 Secret。
2. 在 GitHub 仓库打开 **Releases**，选择最新版本，下载 **Source code (zip)** 并解压。进入解压后的目录，运行以下命令，将示例路径替换成希望 Codex 使用的目录。

   **macOS**

   ```sh
   sh install.sh "/你的项目/绝对路径"
   ```

   **Windows（PowerShell）**

   ```powershell
   node .\install.mjs "C:\你的项目"
   ```

3. 按提示填写 Bot ID、Secret 和工作目录。Secret 在终端隐藏输入。省略路径并接受提示的默认值时，会使用应用数据下的 `WeCom Codex Plugins/workspace`。
4. 在企微私聊机器人，发送安装输出的一次性 `/pair …` 命令。配对后发 `/ping` 确认在线，再发「列出当前工作目录里的文件」验证任务链路。

5. 完全退出并重新打开 Codex，在「设置 → 插件」找到「企微 Codex」。桌面端从 **WeCom Local** 插件源读取它。

运行 Codex 的电脑需要保持开机、系统用户已登录且网络可用。每台电脑建议使用自己的企微机器人。macOS 后台由 LaunchAgent 启动，Windows 由当前用户的任务计划程序启动。

## 日常使用

| 场景 | 操作 |
| --- | --- |
| 私聊派任务 | 发消息或附件，结果回原聊天。再次发消息可以接着问。 |
| 群聊协作 | 添加同一个机器人，由配对账号在目标群 @ 机器人并发 `/group-on`。每个已启用的群独立续接，结果对群成员可见。配对账号用 `/group-off` 停用。 |
| 管理当前会话 | `/ping` 查连接，`/status` 查任务状态，`/new` 开新会话，`/stop` 请求停止任务。在群里需要 @ 机器人，群内 `/new` 仅配对账号可用。 |
| 从电脑取文件 | 配对账号在私聊使用 `/file 相对路径`，可取工作目录内的文件。 |
| 接收本机提醒 | 在桌面端「设置 → Hooks」信任企微 Codex 的 Stop Hook，并启用「本机会话结束提醒」。工作目录内的本机会话结束一轮后，提醒会发到配对私聊。企微任务直接把结果发回原聊天。 |

进入 Codex 桌面端「设置 → 插件 → 企微 Codex」。「打开设置」可配置企微专用模型、推理强度、任务执行时限、回复风格、权限、通知和机器人连接。「会话历史」可打开企微发起的本机会话，包括已归档会话。

## 任务排队和时限

同一个私聊或群聊按消息顺序处理任务。不同聊天最多同时运行两个任务，另外最多可排队四个。群聊里的 `/stop` 只作用于当前群，私聊里的 `/stop` 只作用于当前私聊。

任务默认没有执行时限。可在插件设置的「任务执行」中启用时限并填写分钟数。时限从 Codex 开始实际执行该轮任务时计起，排队时间不计入。更改只应用到保存后开始的任务。

## 权限和数据

- 默认仅配对账号可用。可以开放其他成员仅群聊，或开放其他成员私聊和群聊。群聊还需配对账号单独启用。
- 企微任务默认以只读权限运行。Codex 请求提高权限时，由配对账号在机器人私聊用 `/approve` 或 `/reject` 加一次性审批码处理。
- Bot Secret、会话映射和下载的附件保存在当前用户的数据目录。macOS 使用 `~/Library/Application Support/WeCom Codex/`，Windows 使用 `%LOCALAPPDATA%\WeCom Codex\`。任务由本机 Codex 按其账号和模型配置处理，结果经企业微信送回。

## 更新

1. 在 GitHub 仓库的 **Releases** 查看新版和变更说明。需要收到新版通知时，可以在仓库页面选择 **Watch → Custom → Releases**。
2. 下载新版的 **Source code (zip)** 并解压。保持本机企微后台服务运行，等正在执行的任务结束。
3. 在新版解压目录运行本系统的安装命令。macOS 运行 `sh install.sh`，Windows 运行 `node .\install.mjs`。安装程序会升级插件及后台代码，沿用现有机器人凭据、工作目录和配对。完成后可在 Codex 桌面端的「企微 Codex」插件详情里核对版本。

当前安装使用 Codex 的本地插件源。新版由 GitHub Releases 提供，需要手动下载并运行安装脚本。

## 排查

在项目根目录运行以下命令查看后台状态。

```sh
node wecom-codex/runtime/manage.mjs status
```

将 `status` 换成 `stop` 或 `start` 可停止或恢复连接。配对尚未完成时可用 `pair` 获取配对命令。后台日志是本机数据目录中的 `bridge.log`。

## 开发与贡献

- `.agents/plugins/` 和 `wecom-codex/.codex-plugin/` 定义本地插件源和插件入口。
- `wecom-codex/runtime/` 包含企微长连接、Codex App Server 客户端、后台管理和桌面 MCP 界面。
- `wecom-codex/hooks/` 将本机会话结束事件交给后台服务。
- `test/` 覆盖群聊路由、权限、会话历史、设置和通知。

在项目根目录运行检查。测试使用临时数据，无需配置企微机器人。

```sh
node --check install.mjs
npm ci --prefix wecom-codex --omit=dev --ignore-scripts --no-audit --no-fund
node --test
```

报告问题时，请附上操作系统、Node.js 和 Codex 版本、复现步骤与脱敏日志。欢迎通过 Pull Request 提交修复和对应测试。

## 许可证

[MIT](LICENSE) · Ace
