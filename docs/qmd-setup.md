# QMD 安装与验收

用于首次安装、QMD binary 红灯、空索引或语义检索不可用时。macOS 为主要环境，Linux 尽力兼容；Aha 不支持 Windows 或移动端。本流程使用 QMD CLI，命令接口在本机 QMD 2.5.3 核对过。

安装方式依据 [QMD 官方说明](https://github.com/tobi/qmd#quick-start)；Bun 的安装与 PATH 依据 [Bun 官方说明](https://bun.sh/docs/installation)。已有可工作的 QMD 保持原安装；本流程不会替换它或覆盖其远程推理配置。

## 1. 固定目标与运行时

在同一个 shell 中执行。将 `AHA_SETUP_VAULT` 指向用户指定的真实 vault；collection 必须叫 `obsidian`，与 Aha 的候选 URI 解析约定一致。index 也使用 `obsidian`：当前 CLI adapter 同时把 `qmdIndex` 用作 collection 过滤条件。若现有配置使用其他名字，先核对实际 collection，不应只改 index 名称。

```bash
export AHA_SETUP_VAULT="$HOME/Obsidian Notes"
export AHA_SETUP_INDEX="obsidian"
test -d "$AHA_SETUP_VAULT/.obsidian"
```

预期：退出码 0。验证：`test -d "$AHA_SETUP_VAULT/.obsidian"`。失败时先修正路径。影响后续 Index coverage 灯。

若 `qmd --version` 已成功，直接到步骤 3。安装 QMD 需要 Node 或 Bun；下面以 Bun 为安装工具。QMD 的可执行文件也可能通过 Node 启动，最终以 `qmd --version` 能否执行为准。

```bash
export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  AHA_BUN_INSTALLER="$(mktemp)"
  curl -fsSL https://bun.com/install -o "$AHA_BUN_INSTALLER"
  bash "$AHA_BUN_INSTALLER"
fi
bun --version
```

预期：输出版本号。验证：`bun --version` 退出码 0。Linux 若提示缺少 unzip，先通过系统包管理器安装 unzip；其他失败保留错误，停止后续安装。此步骤是 QMD binary 灯的前置条件。

## 2. 安装 QMD

```bash
if ! command -v qmd >/dev/null 2>&1; then
  bun install -g @tobilu/qmd@2.5.3
fi
qmd --version
command -v qmd
```

预期：版本号和可执行路径。验证：`qmd --version` 退出码 0，`qmd --help` 包含 `collection`、`update`、`embed`、`search`。已存在但不能执行的安装应按原包管理方式修复，避免安装第二份。若终端成功而 Obsidian 红灯，将输出的绝对路径填入 Advanced → QMD path override，再运行 Check Readiness。对应 **QMD binary** 灯。

## 3. 注册 vault 并建立文本索引

先检查既有 collection。存在时核对 `Path` 与目标 vault 的真实路径相同；不同时停止并报告冲突，不移除旧 collection。不存在时才新增。

```bash
if qmd collection show obsidian --index "$AHA_SETUP_INDEX"; then
  qmd collection show obsidian --index "$AHA_SETUP_INDEX"
else
  qmd collection list --index "$AHA_SETUP_INDEX"
  # 仅当上一命令成功且列表确实没有 obsidian 时执行：
  qmd collection add "$AHA_SETUP_VAULT" --name obsidian --mask '**/*.md' --index "$AHA_SETUP_INDEX"
fi
qmd update --index "$AHA_SETUP_INDEX"
```

预期：collection 的 Path 正确，update 成功。验证：`qmd status --index "$AHA_SETUP_INDEX"` 中 `Total` 大于 0；空 vault 需先有用户提供的 Markdown 笔记。重复 update 只处理变化。对应 **Index coverage** 灯；插件目前用文件数量检查覆盖，代理还需独立核对 collection 路径，防止错误 vault 的计数造成误判。

## 4. 生成嵌入并验证一次检索

这是显式的索引建设操作。首次本地推理可能下载模型并占用 CPU/GPU 和内存，几百篇笔记可能需要数分钟或更久，取决于机器和模型；没有固定完成时限。插件只在用户点击 Embed 时执行它，不会后台自动启动。

如插件配置了 QMD environment，执行 shell 命令前将同一组配置放入子进程环境；按 `KEY=VALUE` 解析，不能把字符串当 shell 脚本执行。已有远程服务配置应保留；使用新远程服务前需确认笔记允许发往该服务。

```bash
qmd embed --index "$AHA_SETUP_INDEX"
qmd status --index "$AHA_SETUP_INDEX"
```

预期：embed 退出码 0，`Vectors` 大于 0。验证：重复 embed 应只处理尚未完成的内容；状态显示向量且无待嵌入文档。对应 **QMD inference endpoints** 的配置前置条件。该灯只检查配置和 status，不代表端点真实可达，下面的语义查询才是行为验证。

从一个已索引笔记取一个明确词语替换查询；不要把命令结果或笔记正文发布到公共 issue。

```bash
export AHA_SETUP_QUERY="替换为笔记中的词语"
qmd search "$AHA_SETUP_QUERY" -c obsidian --index "$AHA_SETUP_INDEX" --json -n 3
qmd vsearch "$AHA_SETUP_QUERY" -c obsidian --index "$AHA_SETUP_INDEX" --json -n 3
```

预期：两条命令退出码 0，JSON 中至少一条结果指向预期 collection 内的真实笔记。验证：用结果 URI 执行 `qmd get '<结果 URI>' --index "$AHA_SETUP_INDEX"`，检查正文与源文件相符。关键词与向量检索分别验证文本索引和实际嵌入服务。

## 5. 验证 Aha

在 Settings → Aha 运行 Check Readiness；配置 DeepSeek key 后点击 Test DeepSeek。预期：连接测试成功，**LLM connectivity** 为绿；密钥只保存在插件配置或指定环境变量中，不进入命令参数或验收日志。无 key 时该灯红是预期状态，仍可使用 Recall Tier。

运行 `Aha: Run`，验证结果标明 Full Tier、有原文引句，且能打开候选。无 key 时验证 Recall Tier；缺少 QMD 时验证 Neighborhood Tier。测试缺失依赖应在隔离设置副本或测试 vault 完成，避免覆盖日常配置。一次完整验收还需确认 Surprise 标记在重新打开面板后保留。

## 排障

| 现象 | 处理与复验 |
|---|---|
| QMD binary 红灯 | 使用 `command -v qmd` 的绝对路径；确认 qmd 的运行时也在 Obsidian PATH；重新 Check Readiness |
| Index coverage 红灯 | 核对 index 名和 collection Path，执行步骤 3；零文件时先检查 mask 和 vault 内容 |
| embed / vsearch 失败 | 核对插件与 shell 的 QMD environment 一致；检查实际错误，再重复步骤 4；不以 status 代替检索成功 |
| LLM connectivity 红灯 | 核对 DeepSeek key、base URL、model 和网络，重新 Test DeepSeek；无 key 可继续 Recall Tier |
| Full 降为 Recall | 查看本轮结构化错误；修复后下一轮重新判断能力，无需恢复旧 wrapper |
| 安装命令非零退出 | 停在失败步骤，记录退出码和脱敏错误；不继续声称健康检查通过 |
