import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deliverPetPackage } from './pet-package.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pet-delivery-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'prepared');fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'pet-manifest.json'),JSON.stringify({displayName:'Test',animations:{idle:{frames:[0]}}}));
  for(const name of ['spritesheet.webp','sleep-atlas.webp','life-atlas.webp','fallback.png'])fs.writeFileSync(path.join(source,name),'inert packaging fixture');
  const license=path.join(root,'license.txt');fs.writeFileSync(license,'Synthetic packaging test');
  fs.writeFileSync(path.join(root,'product-version.json'),'unchanged identity');
  return {root,options:{source,license,name:'测试宠物',runId:'test-run'}};
}
test('pet delivery preserves application identity, excludes extra private inputs, and resumes deterministically',t=>{
  const {root,options}=fixture(t);
  fs.writeFileSync(path.join(options.source,'private-photo.jpg'),'PRIVATE_SENTINEL');
  const first=deliverPetPackage(options,root),second=deliverPetPackage({resume:first.runId},root);
  assert.equal(first.outputSha256,second.outputSha256);
  assert.equal(fs.readFileSync(path.join(root,'product-version.json'),'utf8'),'unchanged identity');
  const manifest=JSON.parse(fs.readFileSync(path.join(path.dirname(first.output),'delivery-manifest.json')));
  assert.equal(manifest.inputs['private-photo.jpg'],undefined);
  assert.equal(manifest.candidateOnly,true);
});
test('resume rejects changed source and changed candidate',t=>{
  const {root,options}=fixture(t);const first=deliverPetPackage(options,root);
  fs.appendFileSync(first.output,'tampered');
  assert.throws(()=>deliverPetPackage({resume:first.runId},root),/OUTPUT_DRIFT/);
  fs.appendFileSync(options.license,'changed');
  assert.throws(()=>deliverPetPackage({resume:first.runId},root),/SOURCE_DRIFT/);
});
test('run ids cannot escape the ignored working directory',t=>{
  const {root,options}=fixture(t);
  assert.throws(()=>deliverPetPackage({...options,runId:'../outside'},root),/invalid run id/);
});
