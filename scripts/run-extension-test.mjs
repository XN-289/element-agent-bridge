import { cp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const extensionDevelopmentPath = path.join(os.tmpdir(), 'element-agent-bridge-test');
const extensionTestsPath = path.join(
  extensionDevelopmentPath,
  'out',
  'test',
  'suite',
  'index.js'
);
const fixturePath = path.join(extensionDevelopmentPath, 'test-fixture');

await rm(extensionDevelopmentPath, { recursive: true, force: true });
await mkdir(extensionDevelopmentPath, { recursive: true });
await Promise.all([
  cp(path.join(projectRoot, 'package.json'), path.join(extensionDevelopmentPath, 'package.json')),
  cp(path.join(projectRoot, 'out'), path.join(extensionDevelopmentPath, 'out'), {
    recursive: true
  }),
  cp(path.join(projectRoot, 'test-fixture'), fixturePath, { recursive: true })
]);

try {
  await runTests({
    version: process.env.VSCODE_TEST_VERSION || '1.136.1',
    platform: 'win32-x64-archive',
    cachePath: path.join(projectRoot, '.vscode-test'),
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      fixturePath,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes'
    ]
  });
} finally {
  await rm(extensionDevelopmentPath, { recursive: true, force: true });
}
