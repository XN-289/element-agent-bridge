import * as vscode from 'vscode';
import { sendContextToAgent } from './agentTerminal';
import {
  captureChatRequest,
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
      '还没有可用的元素上下文。请先通过 @element 发送包含页面元素引用的消息。'
    );
  }
  return capture;
}

function presence(value: boolean): string {
  return value ? '有' : '无';
}

function escapeInlineCode(value: string): string {
  return value.replaceAll('`', '\\`');
}
