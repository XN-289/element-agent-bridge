import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  agentTerminalEnvironmentForTests,
  resolveAgentExecutableForTests
} from '../../agentTerminal';
import type { ElementAgentBridgeTestApi } from '../../extension';

const expectedCommands = [
  'elementAgentBridge.sendToClaude',
  'elementAgentBridge.sendToCodex',
  'elementAgentBridge.inspectReferences',
  'elementAgentBridge.openLastContext'
];

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('local.element-agent-bridge');
  assert.ok(extension, 'Element Agent Bridge extension was not discovered');

  const api = (await extension.activate()) as ElementAgentBridgeTestApi;
  assert.equal(extension.isActive, true, 'Element Agent Bridge did not activate');

  const commands = await vscode.commands.getCommands(true);
  for (const command of expectedCommands) {
    assert.ok(commands.includes(command), `Missing registered command: ${command}`);
  }

  const claudeExecutable = await resolveAgentExecutableForTests('claude');
  const codexExecutable = await resolveAgentExecutableForTests('codex');
  assert.ok(claudeExecutable, 'Claude Code executable was not resolved');
  assert.ok(codexExecutable, 'Codex executable was not resolved');
  await fs.access(claudeExecutable);
  await fs.access(codexExecutable);

  const codexEnvironment = agentTerminalEnvironmentForTests('codex');
  assert.equal(
    codexEnvironment?.CODEX_HOME,
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  );

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'The test fixture workspace was not opened');

  const screenshotUri = vscode.Uri.file(
    path.join(workspaceFolder.uri.fsPath, 'synthetic-screenshot.png')
  );
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
    'base64'
  );
  await vscode.workspace.fs.writeFile(screenshotUri, onePixelPng);

  const elementData: Record<string, unknown> = {
    html: '<button id="target-button">Target button</button>',
    css: '#target-button { margin-top: 8px; }',
    pageUrl: 'http://127.0.0.1:4176/',
    screenshot: screenshotUri
  };
  elementData.self = elementData;

  const hostileReference: Record<string, unknown> = {
    longText: 'x'.repeat(260_000),
    deep: {}
  };
  let deepValue: Record<string, unknown> = hostileReference.deep as Record<string, unknown>;
  for (let index = 0; index < 14; index += 1) {
    deepValue.next = {};
    deepValue = deepValue.next as Record<string, unknown>;
  }
  Object.defineProperty(hostileReference, 'throwsOnRead', {
    enumerable: true,
    get() {
      throw new Error('getter must not abort capture');
    }
  });
  hostileReference.binary = new Uint8Array([1, 2, 3]);
  hostileReference.date = new Date('2026-01-02T03:04:05.000Z');
  hostileReference.bigint = 123n;
  hostileReference.callback = () => 'not executed';
  hostileReference.symbol = Symbol('not executed');
  hostileReference.externalImage = vscode.Uri.parse('https://example.com/image.png');
  for (let index = 0; index < 260; index += 1) {
    hostileReference[`key${index}`] = index;
  }

  const capture = await api.captureRequest({
    prompt: '把这个元素向下移动 8px，不要影响同级元素',
    references: [
      {
        id: 'integrated-browser-element',
        modelDescription: 'Synthetic browser element reference',
        value: elementData
      },
      {
        id: 'source-location',
        value: new vscode.Location(
          vscode.Uri.joinPath(workspaceFolder.uri, 'index.html'),
          new vscode.Range(0, 0, 0, 15)
        )
      },
      {
        id: 'hostile-reference',
        value: hostileReference
      }
    ]
  });

  assert.equal(capture.referenceCount, 3);
  assert.deepEqual(capture.signals, {
    html: true,
    css: true,
    screenshot: true,
    url: true
  });

  const contextText = await readUtf8(vscode.Uri.parse(capture.contextFile));
  const referencesText = await readUtf8(vscode.Uri.parse(capture.referencesFile));
  assert.match(contextText, /把这个元素向下移动 8px/);
  assert.match(referencesText, /copiedAttachment/);
  assert.match(referencesText, /circular-reference/);
  assert.match(referencesText, /source-location/);
  assert.match(referencesText, /truncated-string/);
  assert.match(referencesText, /Maximum depth/);
  assert.match(referencesText, /__truncatedKeys/);
  assert.match(referencesText, /property-read-error/);
  assert.match(referencesText, /"kind": "binary"/);
  assert.match(referencesText, /"kind": "date"/);
  assert.match(referencesText, /"kind": "bigint"/);
  assert.match(referencesText, /"kind": "function"/);
  assert.match(referencesText, /"kind": "symbol"/);
  assert.doesNotMatch(referencesText, /example\.com\/image\.png.*copiedAttachment/);
}

async function readUtf8(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const value = Buffer.from(bytes).toString('utf8');
  assert.equal(value.includes('\uFFFD'), false, `Invalid UTF-8 output in ${uri.fsPath}`);
  return value;
}
