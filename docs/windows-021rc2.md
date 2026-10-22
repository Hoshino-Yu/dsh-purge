# Windows 桌面兼容修复

本地修复版：`1.1.71-win021rc2.2`，目标：DeepSeek Harness `0.2.1-rc.2`。
基于 YuJunZhiXue/dsh-purge 1.1.71 镜像；保留原作者署名、LICENSE 和 MIRROR-NOTICE.md。
镜像说明记录的是修复前的归档状态，本地版本已包含下述源码修改。

## 修改

- #40 匹配 0.2.1 的 `requiredContexts` 组装代码，保留必需上下文过滤；兼容旧版 0.2.0 和 CRLF。
- 文件系统封装补回描述符级 `closeSync`、`readSync`，恢复备份句柄释放和 CLI 文件头检测。
- CLI 修复及所有调用方等待原子备份完成；备份失败时返回错误，保留原始 shim。
- 根据组装结果的变量表决定是否使用 `cwd` 插值；未注册时使用静态文案，预设不再无条件声明该变量。
- Windows 重启助手按可执行文件完整路径查找进程，排除自身，避免结束其他安装。
- PowerShell 换包将移动失败转为可捕获错误，并验证归档已移动才启动；脚本使用 UTF-8 BOM。
- 换包脚本的进程判断全部改成可执行文件路径：不再依赖 `DeepSeek Harness.exe` 这个名字，
  重命名过的官方包（例如 `DSH Desktop.exe`）也能结束干净。
- wscript 换包脚本的 WMI 查询走全表按路径过滤，去掉写死的 `WHERE Name = 'DeepSeek Harness.exe'`。
- wscript 起不来（组策略/杀软拦截、System32 精简）时，同步异常和异步 `error` 都退回 PowerShell 换包，
  并清掉 `dsh-purge-official-restarting` 标记；不再因未监听的 `error` 事件崩掉宿主。
- 三条换包路径（PowerShell 立即换、PowerShell 等退出、wscript）在挪走 `app.asar` 之后都先检查
  `resources/app/package.json`：解开的目录不完整就把归档放回原位、写 `.rename-pending` 并退出，
  不会把客户端带进“起不来且归档已被挪走”的状态。

## 验证和打包

在项目目录运行：

```powershell
npm test
npm pack --ignore-scripts
```

测试使用临时目录和模拟进程操作；PowerShell 控制流实际执行，文件锁、成功移动、已解包路径和
`package.json` 缺失时的回滚均有覆盖。
不会结束正在运行的 DSH 或改写本机安装、配置与会话。

### 本机 0.2.1-rc.2 实测（2026-10-22）

安装位置 `D:\Install\dsh-desktop_install\dsh`，插件以 `link:` 指向本项目：

- `enumeratePatchAiBases` 只认 `resources/app/dsh/node_modules/@deepseek-ai` 这一个桌面宿主。
- #40 写入后 system-prompt 文件 20030 → 20725 字节，出现
  `[dsh-purge] complete prompt keeps inject + agent-instructions`，`requiredContexts` 过滤保留；
  再次应用 `changed=false`，`node --check --input-type=module` 通过。
- `ensureHostClean()` 返回 `{ ok: true, pending: [] }`；`patchStatus` 无 pending，
  `hostCleanMarkersPresent` 为 true（此前 #40 一直是 pending，重启因此被取消）。
- `repairOfficialCliAfterUnpack()` 把 `resources/runtime/cli/bin/dsh.cmd` 改成三级回退
  （`app.asar` → `app.asar.unpacked` → `app`），原文件备份为 `dsh.cmd.dsh-purge.bak`。
- 本机只有 `dsh.cmd`，没有 `dsh` shell 脚本，修复按“缺失”跳过，不算失败。

通过 DSH 的插件管理安装生成的 `dsh-purge-1.1.71-win021rc2.2.tgz` 本地包，再在插件面板应用。
实际安装前备份 DSH 配置和会话；点「应用」后由插件自己结束进程、挪走 `app.asar` 并重新打开。
本次验证不包含真实桌面进程退出、Electron 加载新目录和对话请求的端到端操作——
那一步会结束当前会话，需要用户自己触发一次「重启」。

原项目的在线更新渠道仍指向上游，在线更新可能替换本地修复，应保留此安装包。

兼容问题参考：[evilevil/dsh-purge-021rc2](https://github.com/evilevil/dsh-purge-021rc2)。
此处采用本项目内的最小修复，并未整仓合并社区分支。
