import * as vscode from 'vscode';
import { sendContextToAgent } from './agentTerminal';
import {
  pickElementFromBrowser,
  resolveBrowserExecutable
} from './directBrowser';
import {
  captureChatRequest,
  captureDirectElement,
  captureUri,
  loadCapture,
  type CaptureRecord
} from './referenceCapture';

const PARTICIPANT_ID = 'element-agent-bridge.element';

export interface ElementAgentBridgeTestApi {
  captureRequest(
    request: Pick<vscode.ChatRequest, 'prompt' | 'references'>
  ): Promise<CaptureRecord>;
}

export function activate(context: vscode.ExtensionContext): ElementAgentBridgeTestApi {
  const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream) => {
    stream.progress('正在保存浏览器元素引用...');
    const capture = await captureChatRequest(context, request);
    renderCaptureResponse(stream, capture);
    return { metadata: { captureId: capture.captureId } };
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);

  context.subscriptions.push(
    participant,
    vscode.commands.registerCommand('elementAgentBridge.sendToClaude', async () => {
      const capture = await requireLastCapture(context);
      if (capture) {
        await sendContextToAgent('claude', captureUri(capture.contextFile));
      }
    }),
    vscode.commands.registerCommand('elementAgentBridge.sendToCodex', async () => {
      const capture = await requireLastCapture(context);
      if (capture) {
        await sendContextToAgent('codex', captureUri(capture.contextFile));
      }
    }),
    vscode.commands.registerCommand('elementAgentBridge.inspectReferences', async () => {
      const capture = await requireLastCapture(context);
      if (capture) {
        await vscode.window.showTextDocument(captureUri(capture.referencesFile), {
          preview: false
        });
      }
    }),
    vscode.commands.registerCommand('elementAgentBridge.openLastContext', async () => {
      const capture = await requireLastCapture(context);
      if (capture) {
        await vscode.window.showTextDocument(captureUri(capture.contextFile), {
          preview: false
        });
      }
    }),
    vscode.commands.registerCommand('elementAgentBridge.pickElementDirectly', async () => {
      await pickAndSendDirectly(context);
    })
  );

  return {
    captureRequest: (request) =>
      captureChatRequest(context, request as vscode.ChatRequest)
  };
}

export function deactivate(): void {}

function renderCaptureResponse(
  stream: vscode.ChatResponseStream,
  capture: CaptureRecord
): void {
  stream.markdown(`已捕获 ${capture.referenceCount} 个浏览器元素引用。\n\n`);
  stream.markdown(
    [
      `- HTML：${presence(capture.signals.html)}`,
      `- CSS：${presence(capture.signals.css)}`,
      `- 截图：${presence(capture.signals.screenshot)}`,
      `- 页面地址：${presence(capture.signals.url)}`
    ].join('\n')
  );
  stream.markdown(`\n\n引用摘要：\`${escapeInlineCode(capture.preview)}\`\n\n`);
  stream.button({
    command: 'elementAgentBridge.sendToClaude',
    title: '发给 Claude'
  });
  stream.button({
    command: 'elementAgentBridge.sendToCodex',
    title: '发给 Codex'
  });
  stream.button({
    command: 'elementAgentBridge.inspectReferences',
    title: '检查引用'
  });
  stream.reference(captureUri(capture.contextFile));
}

async function requireLastCapture(
  context: vscode.ExtensionContext
): Promise<CaptureRecord | undefined> {
  const capture = await loadCapture(context);
  if (!capture) {
    void vscode.window.showWarningMessage(
      '还没有可用的元素上下文。请先使用“直接选择元素”命令，或通过 @element 发送包含页面元素引用的消息。'
    );
  }
  return capture;
}

async function pickAndSendDirectly(
  context: vscode.ExtensionContext
): Promise<void> {
  const config = vscode.workspace.getConfiguration('elementAgentBridge');
  const previousUrl = context.globalState.get<string>('elementAgentBridge.lastDirectUrl', '');
  const url = await vscode.window.showInputBox({
    title: 'Element Agent Bridge: 选择页面元素',
    prompt: '输入要打开的页面 URL，然后在浏览器里点击目标元素',
    value: previousUrl || 'http://127.0.0.1:4176/',
    validateInput: (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
          ? undefined
          : '只支持 http:// 或 https:// 页面';
      } catch {
        return '请输入完整 URL，例如 http://localhost:3000/';
      }
    }
  });
  if (!url) {
    return;
  }
  await context.globalState.update('elementAgentBridge.lastDirectUrl', url);

  const browserExecutable = await resolveBrowserExecutable(
    config.get<string>('browserExecutable', '')
  );
  if (!browserExecutable) {
    void vscode.window.showErrorMessage(
      '找不到 Edge 或 Chrome。请在设置 elementAgentBridge.browserExecutable 中填写浏览器可执行文件路径。'
    );
    return;
  }

  let element;
  try {
    void vscode.window.showInformationMessage(
      `已打开 ${browserExecutable}。请在浏览器中点击目标元素，按 Esc 取消。`
    );
    element = await pickElementFromBrowser(url, browserExecutable);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`直接选择元素失败：${message}`);
    return;
  }
  if (!element) {
    void vscode.window.showInformationMessage('已取消元素选择。');
    return;
  }

  const prompt = await vscode.window.showInputBox({
    title: 'Element Agent Bridge: 修改要求',
    prompt: '描述你希望 Claude Code 或 Codex 修改什么',
    placeHolder: '例如：把这个按钮向下移动 8px，不要影响父容器',
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : '请输入修改要求'
  });
  if (!prompt) {
    return;
  }

  const capture = await captureDirectElement(context, prompt, element);
  const target = await vscode.window.showQuickPick(
    [
      { label: 'Claude Code', description: '发送到真实 Claude Code CLI' },
      { label: 'Codex', description: '发送到真实 Codex CLI' }
    ],
    {
      title: '选择要接收任务的 Agent',
      placeHolder: '选择后会生成上下文，并聚焦对应终端'
    }
  );
  if (!target) {
    return;
  }

  void vscode.window.showInformationMessage(
    `已捕获元素上下文：${captureUri(capture.contextFile).fsPath}`
  );
  await sendContextToAgent(
    target.label === 'Claude Code' ? 'claude' : 'codex',
    captureUri(capture.contextFile)
  );
}

function presence(value: boolean): string {
  return value ? '有' : '无';
}

function escapeInlineCode(value: string): string {
  return value.replaceAll('`', '\\`');
}
