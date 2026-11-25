import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProject, type StoredAsset } from '../src/core/project';
import { listProjects, load, removeProject, save } from '../src/infrastructure/storage';

test('saves and reloads assets atomically, prevents concurrent overwrite and retains shared assets', async () => {
  const blob = new Blob(['fixture'], { type: 'image/png' });
  const asset: StoredAsset = {
    id: crypto.randomUUID(), mime: 'image/png', sha256: '0'.repeat(64), size: blob.size,
    name: 'fixture.png', duration: 0, width: 512, height: 512, blob,
  };
  const first = { ...createProject('Primeiro'), media: asset.id, visualOptions: [asset.id] };
  const assets = new Map([[asset.id, asset]]);
  const saved = await save(first, assets, null);
  assert.equal(saved.revision, 1);
  const recovered = await load(first.id);
  assert.deepEqual(recovered?.project, saved);
  assert.equal(await recovered?.assets.get(asset.id)?.blob.text(), 'fixture');
  const outcomes = await Promise.allSettled([
    save({ ...saved, name: 'A' }, assets, 1),
    save({ ...saved, name: 'B' }, assets, 1),
  ]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(value => value.status === 'rejected');
  assert.equal(rejected?.reason.message, '4003');
  assert.equal((await load(first.id))?.project.revision, 2);
  assert.equal((await listProjects()).length, 1);

  const duplicated = await save({ ...first, id: crypto.randomUUID() }, assets, null);
  await removeProject(first.id);
  assert.equal(await load(first.id), null);
  assert.equal(await (await load(duplicated.id))?.assets.get(asset.id)?.blob.text(), 'fixture');
  await removeProject();
  assert.deepEqual(await listProjects(), []);
});

test('rejects partial projects before committing any metadata', async () => {
  const project = createProject('Missing asset');
  await assert.rejects(() => save({ ...project, audio: crypto.randomUUID() }, new Map(), null), /4002/);
  assert.equal(await load(project.id), null);
});

test('favorites and personal sounds persist and respect local deletion', async () => {
  const { changeFavorite, favoriteIds, keepSound, personalSounds, removeSound } = await import('../src/infrastructure/storage');
  await changeFavorite('pop', true);
  assert.deepEqual(await favoriteIds(), ['pop']);
  await changeFavorite('pop', false);
  assert.deepEqual(await favoriteIds(), []);
  const sound: StoredAsset = {
    id: crypto.randomUUID(), mime: 'audio/wav', name: 'recorded.wav', size: 4, sha256: '3'.repeat(64),
    duration: 1230, width: 0, height: 0, blob: new Blob(['wave'], { type: 'audio/wav' }),
  };
  await keepSound(sound);
  await keepSound({ ...sound, id: crypto.randomUUID() });
  assert.deepEqual((await personalSounds()).map(item => item.id), [sound.id]);
  await removeSound(sound.id);
  assert.deepEqual(await personalSounds(), []);
});
