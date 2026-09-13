import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packagePet } from '../package_pet.mjs';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const required = ['pet-manifest.json', 'spritesheet.webp', 'sleep-atlas.webp', 'life-atlas.webp', 'fallback.png'];
const optional = ['learning-atlas.webp', 'scene-atlas.webp'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function ordinary(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('PET_PACKAGE_INPUT: expected an ordinary file');
  return fs.readFileSync(file);
}
function inputs(source, license) {
  if (!fs.lstatSync(source).isDirectory() || fs.lstatSync(source).isSymbolicLink()) throw new Error('PET_PACKAGE_INPUT: source must be an ordinary directory');
  const result = {};
  for (const name of [...required, ...optional.filter(name => fs.existsSync(path.join(source, name)))]) result[name] = digest(ordinary(path.join(source, name)));
  result['LICENSE.txt'] = digest(ordinary(license));
  return result;
}
function writeState(file, state) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temporary, file);
}

/** Produces a local candidate; native import/playback acceptance is a separate gate. */
export function deliverPetPackage(options, root = projectRoot) {
  const runId = options.resume ?? options.runId ?? `pet-${randomUUID()}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(runId)) throw new Error('PET_PACKAGE_INPUT: invalid run id');
  const run = path.join(root, 'work', 'pet-customizations', runId);
  const stateFile = path.join(run, 'state.json');
  let state;
  if (options.resume) {
    state = JSON.parse(ordinary(stateFile));
    if (state.schemaVersion !== 1 || state.route !== 'pet-package' || state.runId !== runId) throw new Error('PET_PACKAGE_STATE: invalid state');
  } else {
    if (!options.source || !options.license || !options.name) throw new Error('Use --source <prepared assets> --license <license> --name <pet name>; use customize:standalone for a separate application.');
    if (fs.existsSync(stateFile)) throw new Error('PET_PACKAGE_STATE: use --resume for an existing run');
    const source = path.resolve(options.source), license = path.resolve(options.license);
    const commit = options.sourceCommit ?? null;
    if (commit !== null && !/^[0-9a-f]{40}$/.test(commit)) throw new Error('PET_PACKAGE_INPUT: source commit must be a full commit id');
    if (commit !== null) {
      const actual = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
      if (actual !== commit) throw new Error('PET_PACKAGE_SOURCE_DRIFT: source commit differs');
    }
    state = {schemaVersion:1,route:'pet-package',runId,name:options.name,source,license,sourceCommit:commit,inputs:inputs(source,license),stage:'prepared',createdAt:new Date().toISOString()};
    fs.mkdirSync(run,{recursive:true});
    writeState(stateFile,state);
  }
  if (JSON.stringify(inputs(state.source,state.license)) !== JSON.stringify(state.inputs)) throw new Error('PET_PACKAGE_SOURCE_DRIFT: prepared assets or license changed');
  const delivery = path.join(run,'delivery');
  const output = path.join(delivery,'pet.yuanyuan-pet');
  fs.mkdirSync(delivery,{recursive:true});
  if (!fs.existsSync(output)) packagePet({source:state.source,license:state.license,output,name:state.name});
  // Rebuild from locked inputs so a crash before writing state cannot accept a changed output.
  const verification = path.join(run,`verify-${randomUUID()}.yuanyuan-pet`);
  packagePet({source:state.source,license:state.license,output:verification,name:state.name});
  const expected = digest(ordinary(verification));
  fs.unlinkSync(verification);
  const actual = digest(ordinary(output));
  if (actual !== expected || (state.outputSha256 && actual !== state.outputSha256)) throw new Error('PET_PACKAGE_OUTPUT_DRIFT: existing candidate differs');
  if (JSON.stringify(inputs(state.source,state.license)) !== JSON.stringify(state.inputs)) throw new Error('PET_PACKAGE_SOURCE_DRIFT: inputs changed during packaging');
  const manifest = {schemaVersion:1,route:'pet-package',name:state.name,sourceCommit:state.sourceCommit,inputs:state.inputs,outputSha256:actual,candidateOnly:true,nativeAcceptance:'pending',applicationIdentityChanged:false};
  fs.writeFileSync(path.join(delivery,'delivery-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  fs.writeFileSync(path.join(delivery,'SHA256SUMS.txt'),`${actual}  pet.yuanyuan-pet\n`);
  state.stage='candidate';state.outputSha256=actual;writeState(stateFile,state);
  return {runId,output,outputSha256:actual,candidateOnly:true,resumeCommand:`npm.cmd run customize:pet -- --resume ${runId}`};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2), options={};
    const names={'--source':'source','--license':'license','--name':'name','--source-commit':'sourceCommit','--run-id':'runId','--resume':'resume'};
    for(let i=0;i<args.length;i+=2){if(!names[args[i]]||!args[i+1])throw new Error('PET_PACKAGE_INPUT: unknown or incomplete argument');options[names[args[i]]]=args[i+1];}
    console.log(JSON.stringify(deliverPetPackage(options),null,2));
  } catch(error){console.error(error.message);process.exitCode=1;}
}
