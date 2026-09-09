# Element Agent Bridge

Element Agent Bridge provides a direct browser element workflow for real Claude Code CLI
and Codex CLI terminals. The original VS Code Integrated Browser **Add Element to Chat**
workflow remains available as a compatibility mode.

## Requirements

- VS Code 1.136 or newer
- Claude Code CLI and/or Codex CLI
- Playwright MCP configured for the CLI that will verify the page

## Use

### Direct mode

1. Open the Command Palette and run **Element Agent Bridge: Pick Element Directly**.
2. Enter the page URL. The extension opens a temporary Edge or Chrome window.
3. Hover to see the target outline, then click the element. Press Esc to cancel.
4. Enter the requested change.
5. Choose **Claude Code** or **Codex**.
6. Confirm the prompt in the focused CLI terminal and press Enter. Automatic submission is
   disabled by default.

The direct picker captures the page URL, title, CSS selector, outer HTML, text, attributes,
relevant CSS rules, computed layout properties, bounding box, and an element screenshot.
The temporary browser is closed after capture. The agent's configured Playwright MCP is
used later for refresh and verification.

The direct picker uses a fresh browser profile. It is intended for local development pages
and pages that do not require an existing browser login session.

### VS Code Chat compatibility mode

1. Open the target page in VS Code Integrated Browser.
2. Choose **Add Element to Chat** and select one or more elements.
3. Send a chat prompt such as:

   ```text
   @element 把这个元素向下移动 8px，不要影响同级元素
   ```

4. Select **发给 Claude** or **发给 Codex** in the response.
5. Review the prompt in the terminal and press Enter. `autoSubmit` is disabled by default.

The extension writes a UTF-8 context document under its VS Code global storage directory.
The document contains the user request, workspace paths, safely serialized references, and
instructions to verify the change with Playwright. Likely screenshot or image URIs are copied
into the same capture directory when VS Code permits reading the temporary resource.

## Commands

- `Element Agent Bridge: Send to Claude`
- `Element Agent Bridge: Send to Codex`
- `Element Agent Bridge: Inspect Captured References`
- `Element Agent Bridge: Open Last Context`
- `Element Agent Bridge: Pick Element Directly`

## Settings

- `elementAgentBridge.claudeExecutable`
- `elementAgentBridge.codexExecutable`
- `elementAgentBridge.browserExecutable`
- `elementAgentBridge.autoSubmit`
- `elementAgentBridge.preferredTerminal`
- `elementAgentBridge.terminalStartupDelayMs`
- `elementAgentBridge.keepContextFiles`
- `elementAgentBridge.contextPreviewLength`

With `preferredTerminal: auto`, a new dedicated CLI terminal receives the prompt without
submitting it. If a matching terminal already exists, its state cannot be determined through
the VS Code Terminal API, so the extension focuses it and copies the prompt to the clipboard.
When executable settings are empty on Windows, the extension checks PATH, npm shims, the
Claude Code VS Code extension's native binary, and the Codex desktop app's versioned binary.
Codex terminals inherit the existing `CODEX_HOME`, or default to the user's `.codex` directory
so the CLI reads the same MCP and gateway configuration.

## Development

```powershell
& 'C:\Program Files\nodejs\npm.cmd' install
& 'C:\Program Files\nodejs\npm.cmd' run compile
& 'C:\Program Files\nodejs\npm.cmd' run lint
& 'C:\Program Files\nodejs\npm.cmd' run fixture
```

Press F5 in the extension project to start an Extension Development Host with the included
test fixture workspace.

## Packaging

```powershell
& 'C:\Program Files\nodejs\npx.cmd' @vscode/vsce package
```

This extension does not patch VS Code internals, the Claude Code extension, Codex Browser
Plugin, or either CLI's existing configuration.
