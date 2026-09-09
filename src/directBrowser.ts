import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Page } from 'playwright-core';

const execFileAsync = promisify(execFile);

export interface DirectElementCapture {
  pageUrl: string;
  pageTitle: string;
  selector: string;
  outerHTML: string;
  textContent: string;
  attributes: Record<string, string>;
  computedStyles: Record<string, string>;
  relevantCss: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  screenshot: Uint8Array;
}

interface PickedElementData {
  selector: string;
  outerHTML: string;
  textContent: string;
  attributes: Record<string, string>;
  computedStyles: Record<string, string>;
  relevantCss: string;
  boundingBox: DirectElementCapture['boundingBox'];
}

const PICKER_SCRIPT = String.raw`
(() => {
  if (window.__elementAgentBridgePickerActive) {
    return;
  }

  window.__elementAgentBridgePickerActive = true;
  const marker = 'data-element-agent-bridge-selected';
  const style = document.createElement('style');
  style.dataset.elementAgentBridge = 'picker';
  style.textContent = [
    '[data-element-agent-bridge-hovered="true"] {',
    '  outline: 2px solid #0b6cff !important;',
    '  outline-offset: 2px !important;',
    '  cursor: crosshair !important;',
    '}',
    '#element-agent-bridge-banner {',
    '  position: fixed;',
    '  z-index: 2147483647;',
    '  top: 12px;',
    '  left: 50%;',
    '  transform: translateX(-50%);',
    '  padding: 8px 12px;',
    '  border: 1px solid rgba(255,255,255,.28);',
    '  border-radius: 6px;',
    '  background: #1f2937;',
    '  color: #fff;',
    '  font: 13px/1.4 system-ui, sans-serif;',
    '  box-shadow: 0 4px 16px rgba(0,0,0,.25);',
    '  pointer-events: none;',
    '}'
  ].join('');
  document.documentElement.appendChild(style);

  const banner = document.createElement('div');
  banner.id = 'element-agent-bridge-banner';
  banner.textContent = '点击要修改的元素，按 Esc 取消';
  document.documentElement.appendChild(banner);

  const cssPath = (element) => {
    if (!(element instanceof Element)) {
      return '';
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      if (current.id) {
        parts.unshift('#' + CSS.escape(current.id));
        break;
      }
      let part = current.tagName.toLowerCase();
      const classes = Array.from(current.classList).slice(0, 2);
      if (classes.length) {
        part += classes.map((item) => '.' + CSS.escape(item)).join('');
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(
          (item) => item.tagName === current.tagName
        );
        if (sameTag.length > 1) {
          part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  };

  const collectCss = (element) => {
    const matches = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = Array.from(sheet.cssRules || []);
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (!rule.selectorText) {
          continue;
        }
        try {
          if (element.matches(rule.selectorText)) {
            matches.push(rule.cssText);
          }
        } catch {
          continue;
        }
        if (matches.length >= 30) {
          return matches.join('\n');
        }
      }
    }
    return matches.join('\n');
  };

  const describe = (element) => {
    const computed = getComputedStyle(element);
    const properties = [
      'display', 'position', 'width', 'height', 'margin', 'padding',
      'font-size', 'font-weight', 'line-height', 'color', 'background-color',
      'border', 'border-radius', 'transform', 'top', 'right', 'bottom', 'left'
    ];
    const computedStyles = {};
    for (const property of properties) {
      computedStyles[property] = computed.getPropertyValue(property);
    }
    const attributes = {};
    for (const attribute of Array.from(element.attributes)) {
      attributes[attribute.name] = attribute.value;
    }
    const rect = element.getBoundingClientRect();
    return {
      selector: cssPath(element),
      outerHTML: element.outerHTML,
      textContent: (element.textContent || '').trim().slice(0, 10000),
      attributes,
      computedStyles,
      relevantCss: collectCss(element),
      boundingBox: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      }
    };
  };

  const clearHover = () => {
    document
      .querySelectorAll('[data-element-agent-bridge-hovered="true"]')
      .forEach((item) => item.removeAttribute('data-element-agent-bridge-hovered'));
  };

  const cleanup = () => {
    clearHover();
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    style.remove();
    banner.remove();
    window.__elementAgentBridgePickerActive = false;
  };

  const onMouseOver = (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('#element-agent-bridge-banner')) {
      return;
    }
    clearHover();
    target.setAttribute('data-element-agent-bridge-hovered', 'true');
  };

  const onClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('#element-agent-bridge-banner')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    clearHover();
    target.setAttribute(marker, 'true');
    const data = describe(target);
    cleanup();
    window.__elementAgentBridgeResolve(data);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cleanup();
      window.__elementAgentBridgeResolve(null);
    }
  };

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
})();
`;

export async function resolveBrowserExecutable(
  configured = ''
): Promise<string | undefined> {
  const trimmed = configured.trim();
  if (trimmed && (await fileExists(trimmed))) {
    return trimmed;
  }
  if (trimmed) {
    const fromPath = await findOnPath(trimmed);
    if (fromPath) {
      return fromPath;
    }
  }

  for (const command of ['msedge', 'chrome', 'chromium']) {
    const fromPath = await findOnPath(command);
    if (fromPath) {
      return fromPath;
    }
  }

  const candidates = [
    path.join(
      process.env.PROGRAMFILES || 'C:\\Program Files',
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    ),
    path.join(
      process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    ),
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    ),
    path.join(
      process.env.PROGRAMFILES || 'C:\\Program Files',
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    path.join(
      process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    )
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function pickElementFromBrowser(
  url: string,
  executablePath: string
): Promise<DirectElementCapture | undefined> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath,
    headless: false,
    args: ['--new-window']
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 }
    });
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    });

    const selected = await waitForElementSelection(page);
    if (!selected) {
      return undefined;
    }

    const locator = page.locator('[data-element-agent-bridge-selected="true"]').first();
    const screenshot = await locator.screenshot({ type: 'png' });
    const pageUrl = page.url();
    const pageTitle = await page.title();
    await locator.evaluate((element) => {
      element.removeAttribute('data-element-agent-bridge-selected');
    });

    return {
      pageUrl,
      pageTitle,
      ...selected,
      screenshot
    };
  } finally {
    await browser.close();
  }
}

export async function resolveBrowserExecutableForTests(): Promise<string | undefined> {
  return resolveBrowserExecutable();
}

async function waitForElementSelection(page: Page): Promise<PickedElementData | undefined> {
  return new Promise<PickedElementData | undefined>((resolve, reject) => {
    let settled = false;
    const finish = (value: PickedElementData | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    void page
      .exposeFunction('__elementAgentBridgeResolve', (value: unknown) => {
        if (!value || typeof value !== 'object') {
          finish(undefined);
          return;
        }
        finish(value as PickedElementData);
      })
      .then(() => page.evaluate(PICKER_SCRIPT))
      .catch(reject);

    page.once('close', () => finish(undefined));
  });
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}
