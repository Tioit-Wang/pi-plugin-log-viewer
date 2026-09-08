# 大日志文件查看器（PI-Desktop 插件）

流式分页查看超大日志文件：GB 级文件秒开、实时跟随、全文搜索、级别统计、
多文件页签、拖拽打开。

## 功能

- **GB 级秒开**：按字节分块读取（4 MB/块），粗粒度行索引（每 512 行记一个
  字节偏移），虚拟滚动渲染，内存占用与文件大小无关。
- **实时跟随**：轮询文件增长自动追尾；向上翻阅自动暂停，滚回底部恢复；
  文件轮转（truncate / 重建）自动重载。
- **全文搜索**：关键字/正则、大小写开关、异步扫描带进度可取消、
  F3 / Shift+F3 命中导航、命中高亮。正则有长度与嵌套量词防护（防 ReDoS）。
- **级别统计**：ERROR / WARN / INFO / DEBUG 全文计数徽章，点击进入级别
  过滤视图（可多选）。
- **多文件页签**：一次多选打开多个日志；每页签独立记忆浏览位置、编码、
  跟随与过滤状态，重开面板续看上次位置（拖入文件除外，见下）。
- **复制**：点击行号复制整行、右键菜单复制选中内容。
- **编码**：UTF-8 / GBK / GB18030 按页签切换（行索引基于字节偏移，
  切换编码无需重建索引）。
- **主题与字号**：明 / 暗主题（默认跟随宿主 `app.getAppearance`），日志字号可调。

## 使用

1. 将本目录作为开发插件载入 PI-Desktop（Plugins → Load development
   plugin）。
2. 全局搜索执行命令「大日志文件查看器：打开」，或直接打开插件面板。
3. 「打开文件」→ 选择日志所在目录（宿主授予）→ 在弹层中勾选一个或多个
   **文件**（仅列出该目录下的文件，不可进入子目录、不可返回上一级）→ 打开；
   或直接把 `.log` / `.txt` 拖入窗口。
4. 快捷键：`Ctrl+F` 聚焦搜索、`F3` / `Shift+F3` 命中导航、`Esc` 退出输入。

## 权限

| 权限 | 用途 |
|---|---|
| `ui.panel` | 面板窗口 |
| `fs.read`（root: userSelected） | 触发目录选择器（`fs.requestDirectory`），作为打开文件的会话授权根 |
| `clipboard.write` | 复制整行 / 选中内容 |

## 治理说明（重要）

宿主 `pi.fs` 目前只有整文件 `readText`，没有字节范围读取与 `stat`（见
[vastsa/PI-Desktop#90](https://github.com/vastsa/PI-Desktop/issues/90)）。
GB 级日志无法用宿主 API 分页读取，因此本插件的文件 IO 在插件主进程
（utilityProcess）内直接使用 `node:fs`，**绕过了权限网关的文件范围管控**。
当前通过以下方式对冲：

- 用户选择的目录（`fs.requestDirectory`）是唯一授权入口；引擎在
  `setRoot` 后强制校验所有 `listDir` / `openFile` 路径（含 `realpath`）；
- 选择器只列出该目录下的**文件**，不提供子目录浏览或返回上一级；
- 只读打开（`r` 模式），不提供导出/写入；
- `main.js` 内置能力探测：宿主落地 `fs.readRange` / `stat` 后，可切回
  宿主 API（`engine.ping` 返回 `capabilities`）。

拖入文件走渲染层 Web Worker 的 `Blob.slice` 读取（快照，无实时跟随，
重开面板后需重新拖入）。对应的宿主增强提案见
[docs/host-api-proposals.md](docs/host-api-proposals.md)。

## 架构

```
renderer/index.html + app.js     沙箱面板：虚拟滚动、页签、搜索交互、轮询
renderer/drop-worker.js          拖入文件的 Blob.slice 分块读取
        │ pluginBridge.invoke("engine.*")（宿主转发 → onPanelInvoke）
main.js                          生命周期 + 通道分发
lib/log-engine.js                顺序索引游标 / 稀疏块偏移跳读 / tail / 搜索
        │ node:fs（见治理说明）
```

- 行拆分基于原始字节（0x0A），UTF-8 / GBK / GB18030 均不会在多字节序列
  中出现 0x0A，字节偏移与编码无关。
- 顺序游标负责统计与 tail；任意跳读（分页、搜索）从最近块偏移起点本地
  计数，不移动游标。
- tail 增量通过小环形缓冲（4000 行）下发；客户端落后过多时收到
  `catchup` 信号并重新分页。
- 文件末行即使没有结尾换行也会被索引；轮转时旧 `FileHandle` 等到在飞
  读取结束后再关闭。

## 已知限制

- 拖入文件为快照：不跟随增长、状态不持久化（等宿主拖拽授权落地）。
- 级别过滤视图为顺序流式浏览，不支持按行号定位。
- 搜索定位前 5000 处（计数完整）。
- 单文件行长度截断 4000 字符；面板对宿主无感知的极长行（>16 MB 无换行）
  会强制断行。
- 正则搜索会拒绝过长或含嵌套量词的表达式（防灾难性回溯）。
- 无导出功能；可用行号点击 / 右键复制。
- Ctrl+G 行号跳转、时间戳跳转、书签、columnizer、远程日志：规划中。

## 开发

```bash
# 语法检查
node --check main.js && node --check lib/log-engine.js

# 清单校验（在 PI-Desktop 仓库根目录）
pnpm pi-plugin check F:\pi-plugin-log-viewer
```

加载为开发插件后支持热重载（改动后约 300 ms 自动重载）。
