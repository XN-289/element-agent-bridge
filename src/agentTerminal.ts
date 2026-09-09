import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

export type AgentKind = 'claude' | 'codex';

interface AgentDefinition {
  setting: 'claudeExecutable' | 'codexExecutable';
  command: string;
  terminalName: string;
  displayName: string;
}

const execFileAsync = promisify(execFile);

const agents: Record<AgentKind, AgentDefinition> = {
  claude: {
    setting: 'claudeExecutable',
    command: 'claude',
    terminalName: 'Claude Code',
    displayName: 'Claude Code'
  },
  codex: {
    setting: 'codexExecutable',
    command: 'codex',
    terminalName: 'Codex',
    displayName: 'Codex'
  }
};

export async function sendContextToAgent(
  agentKind: AgentKind,
  contextFile: vscode.Uri
): Promise<void> {
  const agent = agents[agentKind];
  const config = vscode.workspace.getConfiguration('elementAgentBridge');
  const mode = config.get<'auto' | 'terminal' | 'clipboard'>('preferredTerminal', 'auto');
  const autoSubmit = config.get<boolean>('autoSubmit', false);
  const startupDelay = config.get<number>('terminalStartupDelayMs', 1800);
  const handoffPrompt = buildHandoffPrompt(contextFile);

  let terminal = findAgentTerminal(agent);
  const terminalAlreadyExisted = Boolean(terminal);

  if (!terminal) {
    const executable = await resolveExecutable(agent);
    if (!executable) {
      const settingName = `elementAgentBridge.${agent.setting}`;
      void vscode.window.showErrorMessage(
        `找不到 ${agent.displayName} CLI。请在设置 ${settingName} 中填写可执行文件路径。`
      );
      return;
    }

    terminal = createAgentTerminal(agent);
    terminal.show(true);
    terminal.sendText(quoteForCmd(executable), true);
    await delay(startupDelay);
  } else {
    terminal.show(true);
  }

  if (mode === 'clipboard' || (mode === 'auto' && terminalAlreadyExisted)) {
    await vscode.env.clipboard.writeText(handoffPrompt);
    void vscode.window.showInformationMessage(
      `Prompt 已复制并已聚焦 ${agent.displayName} 终端。请按 Ctrl+V，确认后按 Enter。`
    );
    return;
  }

  terminal.sendText(handoffPrompt, autoSubmit);
  if (autoSubmit) {
    void vscode.window.showInformationMessage(`Prompt 已发送到 ${agent.displayName}。`);
  } else {
    void vscode.window.showInformationMessage(
      `Prompt 已放入 ${agent.displayName} 终端，请确认后按 Enter。`
    );
  }
}

function buildHandoffPrompt(contextFile: vscode.Uri): string {
  return [
    `Read the UTF-8 context document at "${contextFile.fsPath}".`,
    'Implement the requested source change in the referenced workspace.',
    'Then use the configured Playwright MCP to refresh the page, capture a snapshot and screenshot,',
    'verify the target element, and report changed files plus verification results.'
  ].join(' ');
}

function findAgentTerminal(agent: AgentDefinition): vscode.Terminal | undefined {
  const expected = agent.terminalName.toLocaleLowerCase();
  return vscode.window.terminals.find((terminal) =>
    terminal.name.toLocaleLowerCase().includes(expected)
  );
}

function createAgentTerminal(agent: AgentDefinition): vscode.Terminal {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return vscode.window.createTerminal({
    name: agent.terminalName,
    cwd,
    shellPath: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    shellArgs: ['/d', '/k'],
    env: terminalEnvironment(agent)
  });
}

async function resolveExecutable(agent: AgentDefinition): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration('elementAgentBridge')
    .get<string>(agent.setting, '')
    .trim();

  if (configured) {
    return configured;
  }

  const fromPath = await findOnPath(agent.command);
  if (fromPath) {
    return fromPath;
  }

  for (const candidate of knownWindowsCandidates(agent.command)) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return findInstalledWindowsExecutable(agent.command);
}

export async function resolveAgentExecutableForTests(
  agentKind: AgentKind
): Promise<string | undefined> {
  return resolveExecutable(agents[agentKind]);
}

export function agentTerminalEnvironmentForTests(
  agentKind: AgentKind
): Record<string, string> | undefined {
  return terminalEnvironment(agents[agentKind]);
}

function terminalEnvironment(agent: AgentDefinition): Record<string, string> | undefined {
  if (agent.command !== 'codex') {
    return undefined;
  }

  return {
    CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  };
}

async function findInstalledWindowsExecutable(command: string): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    return undefined;
  }

  const candidates: string[] = [];

  if (command === 'claude') {
    for (const extensionRoot of [
      path.join(os.homedir(), '.vscode', 'extensions'),
      path.join(os.homedir(), '.vscode-insiders', 'extensions')
    ]) {
      candidates.push(
        ...(await versionedExecutableCandidates(
          extensionRoot,
          'anthropic.claude-code-',
          path.join('resources', 'native-binary', 'claude.exe')
        ))
      );
    }
  }

  if (command === 'codex') {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const codexBin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    candidates.push(path.join(codexBin, 'codex.exe'));
    candidates.push(
      ...(await versionedExecutableCandidates(codexBin, '', 'codex.exe'))
    );
  }

  const existing = await Promise.all(
    [...new Set(candidates)].map(async (candidate) => {
      try {
        const stat = await fs.stat(candidate);
        return stat.isFile() ? { candidate, modified: stat.mtimeMs } : undefined;
      } catch {
        return undefined;
      }
    })
  );

  return existing
    .filter(
      (entry): entry is { candidate: string; modified: number } => entry !== undefined
    )
    .sort((left, right) => right.modified - left.modified)[0]?.candidate;
}

async function versionedExecutableCandidates(
  root: string,
  directoryPrefix: string,
  executableRelativePath: string
): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.toLocaleLowerCase().startsWith(directoryPrefix.toLocaleLowerCase())
      )
      .map((entry) => path.join(root, entry.name, executableRelativePath));
  } catch {
    return [];
  }
}

async function findOnPath(command: string): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    return command;
  }

  try {
    const result = await execFileAsync('where.exe', [command], {
      windowsHide: true,
      encoding: 'utf8'
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

function knownWindowsCandidates(command: string): string[] {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    path.join(appData, 'npm', `${command}.cmd`),
    path.join(appData, 'npm', command)
  ];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function quoteForCmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
