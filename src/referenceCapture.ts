import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { DirectElementCapture } from './directBrowser';

const LAST_CAPTURE_KEY = 'elementAgentBridge.lastCapture';
const MAX_DEPTH = 10;
const MAX_OBJECT_KEYS = 250;
const MAX_STRING_LENGTH = 250_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface CaptureSignals {
  html: boolean;
  css: boolean;
  screenshot: boolean;
  url: boolean;
}

export interface CaptureRecord {
  captureId: string;
  createdAt: string;
  prompt: string;
  workspaceFolders: string[];
  contextFile: string;
  referencesFile: string;
  referenceCount: number;
  signals: CaptureSignals;
  preview: string;
}

interface StoredCapturePointer {
  manifestUri: string;
}

interface NormalizationState {
  seen: WeakMap<object, string>;
  captureDirectory: vscode.Uri;
  attachmentDirectory: vscode.Uri;
  attachmentCounter: number;
}

export async function captureChatRequest(
  extensionContext: vscode.ExtensionContext,
  request: vscode.ChatRequest
): Promise<CaptureRecord> {
  return captureReferences(extensionContext, request.prompt, request.references);
}

export async function captureDirectElement(
  extensionContext: vscode.ExtensionContext,
  prompt: string,
  element: DirectElementCapture
): Promise<CaptureRecord> {
  const temporaryScreenshot = path.join(
    os.tmpdir(),
    `element-agent-bridge-${randomUUID()}.png`
  );
  await fs.writeFile(temporaryScreenshot, element.screenshot);
  try {
    return captureReferences(extensionContext, prompt, [
      {
        id: 'direct-browser-element',
        modelDescription: 'Element selected with Element Agent Bridge direct browser picker',
        value: {
          pageUrl: element.pageUrl,
          pageTitle: element.pageTitle,
          selector: element.selector,
          outerHTML: element.outerHTML,
          textContent: element.textContent,
          attributes: element.attributes,
          computedStyles: element.computedStyles,
          relevantCss: element.relevantCss,
          boundingBox: element.boundingBox,
          screenshot: vscode.Uri.file(temporaryScreenshot)
        }
      }
    ]);
  } finally {
    await fs.rm(temporaryScreenshot, { force: true });
  }
}

async function captureReferences(
  extensionContext: vscode.ExtensionContext,
  prompt: string,
  inputReferences: readonly {
    id?: string;
    modelDescription?: string;
    value: unknown;
    range?: unknown;
  }[]
): Promise<CaptureRecord> {
  const storageRoot = await resolveStorageRoot(extensionContext);
  const config = vscode.workspace.getConfiguration('elementAgentBridge');
  const keepContextFiles = config.get<boolean>('keepContextFiles', false);

  if (!keepContextFiles) {
    await deleteIfPresent(storageRoot);
  }
  await vscode.workspace.fs.createDirectory(storageRoot);

  const captureId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const captureDirectory = vscode.Uri.joinPath(storageRoot, captureId);
  const attachmentDirectory = vscode.Uri.joinPath(captureDirectory, 'attachments');
  await vscode.workspace.fs.createDirectory(attachmentDirectory);

  const state: NormalizationState = {
    seen: new WeakMap(),
    captureDirectory,
    attachmentDirectory,
    attachmentCounter: 0
  };

  const references = [];
  for (let index = 0; index < inputReferences.length; index += 1) {
    const reference = inputReferences[index];
    const raw = reference as unknown as Record<string, unknown>;
    references.push({
      index: index + 1,
      id: reference.id,
      modelDescription: reference.modelDescription,
      range: await normalizeUnknown(raw.range, state, `references[${index}].range`, 0),
      value: await normalizeUnknown(
        reference.value,
        state,
        `references[${index}].value`,
        0
      )
    });
  }

  const workspaceFolders =
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const serializedText = JSON.stringify(references, null, 2);
  const signals = detectSignals(serializedText);
  const previewLength = config.get<number>('contextPreviewLength', 240);
  const preview = createPreview(serializedText, previewLength);
  const contextFile = vscode.Uri.joinPath(captureDirectory, 'element-context.md');
  const referencesFile = vscode.Uri.joinPath(captureDirectory, 'references.json');
  const manifestFile = vscode.Uri.joinPath(captureDirectory, 'manifest.json');

  const record: CaptureRecord = {
    captureId,
    createdAt: new Date().toISOString(),
    prompt,
    workspaceFolders,
    contextFile: contextFile.toString(true),
    referencesFile: referencesFile.toString(true),
    referenceCount: references.length,
    signals,
    preview
  };

  await writeUtf8(referencesFile, `${serializedText}\n`);
  await writeUtf8(contextFile, buildContextDocument(record, references));
  await writeUtf8(manifestFile, `${JSON.stringify(record, null, 2)}\n`);
  await extensionContext.globalState.update(LAST_CAPTURE_KEY, {
    manifestUri: manifestFile.toString(true)
  } satisfies StoredCapturePointer);

  return record;
}

export async function loadCapture(
  extensionContext: vscode.ExtensionContext
): Promise<CaptureRecord | undefined> {
  const pointer = extensionContext.globalState.get<StoredCapturePointer>(LAST_CAPTURE_KEY);
  if (!pointer?.manifestUri) {
    return undefined;
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(pointer.manifestUri));
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as CaptureRecord;
  } catch {
    return undefined;
  }
}

export function captureUri(value: string): vscode.Uri {
  return vscode.Uri.parse(value);
}

async function resolveStorageRoot(
  extensionContext: vscode.ExtensionContext
): Promise<vscode.Uri> {
  const preferred = vscode.Uri.joinPath(extensionContext.globalStorageUri, 'captures');
  try {
    await vscode.workspace.fs.createDirectory(preferred);
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), 'element-agent-bridge', 'captures');
    const fallbackUri = vscode.Uri.file(fallback);
    await vscode.workspace.fs.createDirectory(fallbackUri);
    return fallbackUri;
  }
}

async function normalizeUnknown(
  value: unknown,
  state: NormalizationState,
  objectPath: string,
  depth: number
): Promise<unknown> {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return { kind: 'bigint', value: value.toString() };
  }
  if (typeof value === 'symbol' || typeof value === 'function') {
    return { kind: typeof value, value: safeToString(value) };
  }

  if (value instanceof vscode.Uri) {
    return normalizeUri(value, state, objectPath);
  }
  if (value instanceof vscode.Location) {
    return {
      kind: 'location',
      uri: await normalizeUri(value.uri, state, `${objectPath}.uri`),
      range: normalizeRange(value.range)
    };
  }
  if (value instanceof vscode.Range) {
    return normalizeRange(value);
  }
  if (value instanceof vscode.Position) {
    return { kind: 'position', line: value.line, character: value.character };
  }
  if (value instanceof Uint8Array) {
    return {
      kind: 'binary',
      byteLength: value.byteLength,
      note: 'Binary data omitted from JSON serialization.'
    };
  }
  if (value instanceof Date) {
    return { kind: 'date', value: value.toISOString() };
  }
  if (depth >= MAX_DEPTH) {
    return { kind: 'truncated', reason: `Maximum depth ${MAX_DEPTH} reached.` };
  }

  const objectValue = value as object;
  const seenAt = state.seen.get(objectValue);
  if (seenAt) {
    return { kind: 'circular-reference', target: seenAt };
  }
  state.seen.set(objectValue, objectPath);

  if (Array.isArray(value)) {
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      output.push(
        await normalizeUnknown(value[index], state, `${objectPath}[${index}]`, depth + 1)
      );
    }
    return output;
  }

  const output: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(value as Record<string, unknown>);
  } catch (error) {
    return {
      kind: 'uninspectable-object',
      error: errorMessage(error),
      value: safeToString(value)
    };
  }

  for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
    try {
      const child = (value as Record<string, unknown>)[key];
      output[key] = await normalizeUnknown(child, state, `${objectPath}.${key}`, depth + 1);
    } catch (error) {
      output[key] = { kind: 'property-read-error', error: errorMessage(error) };
    }
  }

  if (keys.length > MAX_OBJECT_KEYS) {
    output.__truncatedKeys = keys.length - MAX_OBJECT_KEYS;
  }
  if (keys.length === 0) {
    output.__stringValue = safeToString(value);
  }

  return output;
}

async function normalizeUri(
  uri: vscode.Uri,
  state: NormalizationState,
  objectPath: string
): Promise<Record<string, unknown>> {
  const normalized: Record<string, unknown> = {
    kind: 'uri',
    value: uri.toString(true),
    scheme: uri.scheme,
    authority: uri.authority,
    path: uri.path,
    query: uri.query,
    fragment: uri.fragment
  };

  const attachment = await copyLikelyAttachment(uri, state, objectPath);
  if (attachment) {
    normalized.copiedAttachment = attachment.toString(true);
  }
  return normalized;
}

async function copyLikelyAttachment(
  uri: vscode.Uri,
  state: NormalizationState,
  objectPath: string
): Promise<vscode.Uri | undefined> {
  if (uri.scheme === 'http' || uri.scheme === 'https') {
    return undefined;
  }

  const hint = `${uri.path} ${objectPath}`.toLocaleLowerCase();
  if (!/(screenshot|image|\\.png|\\.jpe?g|\\.webp|\\.gif|\\.bmp|\\.avif)/.test(hint)) {
    return undefined;
  }

  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    const extension = path.extname(uri.path) || '.bin';
    const filename = `attachment-${++state.attachmentCounter}${extension}`;
    const destination = vscode.Uri.joinPath(state.attachmentDirectory, filename);
    await vscode.workspace.fs.writeFile(destination, bytes);
    return destination;
  } catch {
    return undefined;
  }
}

function normalizeRange(range: vscode.Range): Record<string, unknown> {
  return {
    kind: 'range',
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

function detectSignals(serializedText: string): CaptureSignals {
  const lower = serializedText.toLocaleLowerCase();
  return {
    html: /<[a-z][\s\S]*?>/.test(serializedText) || /"(html|outerhtml|innerhtml|markup)"/.test(lower),
    css: /"(css|styles?|computedstyle|stylesheet)"/.test(lower),
    screenshot: /"(screenshot|image|copiedattachment)"/.test(lower) || /\.(png|jpe?g|webp|gif|bmp|avif)/.test(lower),
    url: /https?:\\?\/\\?\//.test(lower) || /"(url|pageurl|href)"/.test(lower)
  };
}

function buildContextDocument(record: CaptureRecord, references: unknown[]): string {
  const workspace =
    record.workspaceFolders.length > 0
      ? record.workspaceFolders.map((folder) => `- ${folder}`).join('\n')
      : '- No workspace folder is open.';

  const referenceSections = references
    .map((reference, index) => {
      return [
        `### Reference ${index + 1}`,
        '',
        '```json',
        JSON.stringify(reference, null, 2),
        '```'
      ].join('\n');
    })
    .join('\n\n');

  return [
    '# Element Agent Context',
    '',
    '## User request',
    '',
    record.prompt || '(No additional user request was provided.)',
    '',
    '## Workspace',
    '',
    workspace,
    '',
    '## Browser element references',
    '',
    referenceSections || '(No references were attached.)',
    '',
    '## Agent instructions',
    '',
    '1. Only modify the element or elements identified by the attached references.',
    '2. Use HTML, classes, IDs, text, page URL, CSS, screenshots, and surrounding context to locate the actual source.',
    '3. Confirm the target source file before editing so similarly named elements are not changed.',
    '4. Make the smallest practical source change and do not modify VS Code internals or official extensions.',
    '5. After editing, use the configured Playwright MCP to open or refresh the page.',
    '6. Capture a browser snapshot and screenshot, and inspect the target element dimensions or computed layout when relevant.',
    '7. Report changed files, the page used for verification, and the verification result.',
    ''
  ].join('\n');
}

function createPreview(serializedText: string, maximumLength: number): string {
  const compact = serializedText.replace(/\s+/g, ' ').trim();
  if (compact.length <= maximumLength) {
    return compact;
  }
  return `${compact.slice(0, maximumLength)}...`;
}

function truncateString(value: string): string | Record<string, unknown> {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }
  return {
    kind: 'truncated-string',
    originalLength: value.length,
    value: value.slice(0, MAX_STRING_LENGTH)
  };
}

function safeToString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[Unable to convert value to string]';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : safeToString(error);
}

async function writeUtf8(uri: vscode.Uri, value: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(value, 'utf8'));
}

async function deleteIfPresent(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
  } catch {
    // The directory does not exist on the first capture.
  }
}
