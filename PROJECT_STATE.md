# PROJECT_STATE

Updated: 2026-09-09 18:58 +08:00
Current phase: handoff

## 一句话现状
Element Agent Bridge 已完成绕过 VS Code 原生 Chat 的直接浏览器选取 MVP；0.2.0 改动已提交并推送到 GitHub `main`。

## 已接受事实
- 项目名称为 `element-agent-bridge`，VS Code 扩展显示名为 Element Agent Bridge — `package.json`
- 扩展复用 VS Code Integrated Browser 的原生 Add Element to Chat 引用 — `src/extension.ts`, `src/referenceCapture.ts`
- Claude Code 与 Codex 通过 VS Code Terminal API 接收真实 CLI Prompt，不修改官方扩展或内部代码 — `src/agentTerminal.ts`, `README.md`
- Playwright MCP 已分别配置到 Claude Code 与 Codex，现有 Browser Plugin 配置保持不变 — 本机 CLI 配置检查结果
- 直接模式通过独立 Edge/Chrome 窗口选择元素，不依赖 VS Code Integrated Browser 或原生 Chat — `src/directBrowser.ts`, `src/extension.ts`
- 0.2.0 直接模式提交为 `f190afb`，已推送到远程 `main` — `git log`, `git push`

## 已实现
- Chat Participant `@element` — `src/extension.ts`
- 安全引用序列化，覆盖循环引用、深层对象、长字符串、特殊值、图片 URI 和 Location — `src/referenceCapture.ts`, `src/test/suite/index.ts`
- 上下文文件写入 VS Code globalStorage，并提供 Claude/Codex 发送、检查和打开命令 — `src/extension.ts`, `src/agentTerminal.ts`
- 默认不自动提交，现有匹配终端使用剪贴板回退 — `src/agentTerminal.ts`, `package.json`
- 直接模式捕获页面 URL、标题、CSS selector、outerHTML、文本、属性、相关 CSS、计算样式、尺寸和元素截图 — `src/directBrowser.ts`
- VSIX `element-agent-bridge-0.2.0.vsix` — `npm run package`
- 源项目和桌面交付副本均已加入 `.playwright-mcp/`、`validation/` 等生成物忽略规则 — `.gitignore`

## 已验收
- `npm run compile` — 通过
- `npm run lint` — 通过
- `npm run test:extension` — 通过，包含对抗性引用数据测试
- `npm run package` — 已通过，生成 0.2.0 VSIX；本轮提交前需再次确认最终产物
- Claude Code Playwright MCP — `playwright` Connected
- Codex Playwright MCP — 可读取配置并完成导航、snapshot、evaluate 和截图验证
- 桌面副本敏感信息扫描 — `Unique secret-like candidates: 0`
- 完整本机边界扫描发现 318 组疑似候选，均位于 Claude/Codex 本地日志；未复制到交付目录 — 发布前安全扫描结果
- GitHub 远程为 `git@github.com:XN-289/element-agent-bridge.git`，已有提交 `782f4a4`、`7be4fd3` — `git remote -v`, `git log`

## 未决问题
- P1 — 尚未在生产 VS Code UI 中手动完成一次真实 Integrated Browser Add Element to Chat 流程 — 需要 Extension Development Host 或生产窗口人工点击验收
- P2 — 自动判断现有 Claude/Codex TUI 是否空闲受 VS Code Terminal API 限制 — 保留聚焦终端并复制到剪贴板的安全回退

## 下一步
1. 在生产 VS Code UI 手动验收直接模式 — 确认实际点击交互和 CLI 终端交接
2. 如需保留原生兼容模式，再手动验收 Integrated Browser Add Element to Chat — 确认实际引用结构

## 恢复上下文
- 入口目录：`C:\Users\linma\Desktop\element-agent-bridge`
- 桌面交付目录：`C:\Users\linma\Desktop\element-agent-bridge`
- 验证命令：`npm install`, `npm run compile`, `npm run lint`, `npm run test:extension`, `npm run package`
- 已知坑：Windows 中文/空格路径；不要把 `node_modules`、`out`、`.vscode-test`、`.playwright-mcp`、`validation` 或 VSIX 放入源码仓库

## 最近更新
- 2026-09-09 — 增加直接浏览器选取模式，保留原生 Chat 兼容模式 — 0.2.0
- 2026-09-09 — 完成对抗性测试并重新打包 VSIX — 发布前整理
- 2026-09-09 — 提交 `f190afb` 并推送到 GitHub `main` — 远程交付完成
- 2026-09-09 — 创建桌面 GitHub-ready 副本并完成独立安装、编译、Lint、Extension Host 测试和敏感信息扫描 — 可发布
- 2026-09-09 — 推送初始提交到 GitHub `main` — 远程交付完成
