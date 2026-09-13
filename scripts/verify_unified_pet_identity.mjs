import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function verifyUnifiedPetIdentity(root) {
  const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const [authority, brand, tauri, npm, manifest] = await Promise.all([
    json('product-version.json'), json('product-brand.json'), json('src-tauri/tauri.conf.json'),
    json('package.json'), json('public/assets/pet/pet-manifest.json'),
  ]);
  assert.equal(authority.brandConfig, undefined, 'unified application must not enable standalone branding');
  for (const identity of [authority.identifier, brand.application.identifier, tauri.identifier, brand.storage.directoryName])
    assert.equal(identity, 'com.yuanyuan.reminder', 'pet packages must preserve the application data directory');
  for (const name of [authority.productName, brand.application.displayName, tauri.productName]) assert.equal(name, '圆圆提醒');
  assert.equal(npm.name, 'yuanyuan-reminder');
  assert.equal(brand.storage.mainDatabaseFile, 'yuanyuan-reminder.sqlite3');
  assert.equal(brand.storage.learningDatabaseFile, 'yuanyuan-learning.sqlite3');
  assert.equal(brand.assets.licenseFile, 'ASSETS_LICENSE.md');
  assert.equal(brand.pet.displayName, '圆圆');
  assert.equal(manifest.displayName, '圆圆');
  const profile = await readFile(path.join(root, 'src/pet/petProfile.ts'), 'utf8');
  assert.match(profile, /template\.replaceAll\("\{pet\}", name\)/u);
  const main = await readFile(path.join(root, 'src/main.tsx'), 'utf8');
  assert.doesNotMatch(main + profile, /MutationObserver|createTreeWalker|installLegacyBrandCopyAdapter/u,
    'pet names must not rewrite user content through the DOM');
}
