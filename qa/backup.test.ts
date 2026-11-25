import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { createProject } from '../src/core/project';
import { readBackup } from '../src/infrastructure/backup';

const files = () => ({
  'manifest.json': strToU8(JSON.stringify({ schemaVersion: 1, minReaderVersion: 1, assets: [] })),
  'project.json': strToU8(JSON.stringify(createProject('QA'))),
  'licenses.json': strToU8('[]'),
  'preview.webp': strToU8('RIFF0000WEBP'),
});
const zip = (contents: Record<string, Uint8Array>) => new Blob([zipSync(contents, { level: 6 }) as Uint8Array<ArrayBuffer>]);

test('reads a compressed project with no uploaded assets', async () => {
  const project = await readBackup(zip(files()), new AbortController().signal);
  assert.equal(project.project.name, 'QA');
  assert.equal(project.assets.size, 0);
});

test('rejects unexpected ZIP paths and inconsistent backup references', async () => {
  await assert.rejects(() => readBackup(zip({ ...files(), 'unexpected.txt': strToU8('unexpected') }), new AbortController().signal), /4002/);
  const content = files();
  const project = { ...createProject('QA'), audio: crypto.randomUUID() };
  content['project.json'] = strToU8(JSON.stringify(project));
  await assert.rejects(() => readBackup(zip(content), new AbortController().signal), /4002/);
});

test('can cancel restore before exposing a decoded project', async () => {
  const operation = new AbortController();
  operation.abort();
  await assert.rejects(() => readBackup(zip(files()), operation.signal), { name: 'AbortError' });
});
