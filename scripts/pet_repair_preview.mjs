import fs from "node:fs";
import path from "node:path";

// Shared by the standalone player and its timing tests. Times are milliseconds.
export function frameAt(def, elapsed, { still = false, settle = false, speed = 1 } = {}) {
  if (!def || !Array.isArray(def.frames) || !def.frames.length || !Array.isArray(def.durations)
    || def.frames.length !== def.durations.length || def.frames.some(n => !Number.isInteger(n) || n < 0 || n > 7)
    || def.durations.some(n => !Number.isFinite(n) || n <= 0)
    || (def.loopStart !== null && (!Number.isInteger(def.loopStart) || def.loopStart < 0 || def.loopStart >= def.frames.length))) return null;
  const staticColumn = Number.isInteger(def.staticFrame) && def.staticFrame >= 0 && def.staticFrame < 8 ? def.staticFrame : def.frames[0];
  if (still || (settle && def.frames.length === 1)) return { column: staticColumn, index: 0, completed: false };
  if (def.frames.length === 1) return { column: def.frames[0], index: 0, completed: false };
  let time = Math.max(0, elapsed) * Math.max(0.4, Math.min(2, speed));
  const total = def.durations.reduce((a, b) => a + b, 0);
  let start = 0;
  if (time >= total) {
    if (def.loopStart === null || settle) return { column: settle ? staticColumn : def.frames.at(-1), index: def.frames.length - 1, completed: true };
    start = def.loopStart;
    time = (time - total) % def.durations.slice(start).reduce((a, b) => a + b, 0);
  }
  for (let index = start; index < def.frames.length; index++) {
    if (time < def.durations[index]) return { column: def.frames[index], index, completed: false };
    time -= def.durations[index];
  }
  return null;
}

// Review schedule: play the first traversal (plus one repeat for loops), then
// start the selected next action at index zero. This is not the app state machine.
export function transitionAt(manifest, action, nextAction, elapsed, options = {}) {
  const def = manifest.animations?.[action];
  if (!frameAt(def, 0, options)) return null;
  const total = def.durations.reduce((a, b) => a + b, 0);
  const repeat = def.loopStart === null || options.settle ? 0 : def.durations.slice(def.loopStart).reduce((a, b) => a + b, 0);
  const boundary = (total + repeat) / Math.max(0.4, Math.min(2, options.speed ?? 1));
  const selected = nextAction && !options.still && elapsed >= boundary ? nextAction : action;
  const selectedDef = manifest.animations?.[selected];
  return { action: selected, definition: selectedDef, ...frameAt(selectedDef, selected === action ? elapsed : elapsed - boundary,
    { ...options, still: options.still || selected === "work-focus-loop" }) };
}

export function renderComparison(before, after, beforeDir, afterDir, report) {
  const sheets = { standard: "spritesheet.webp", sleep: "sleep-atlas.webp", life: "life-atlas.webp", learning: "learning-atlas.webp", scene: "scene-atlas.webp" };
  const assets = directory => Object.fromEntries(Object.entries(sheets).filter(([, file]) => fs.existsSync(path.join(directory, file)))
    .map(([sheet, file]) => [sheet, "data:image/webp;base64," + fs.readFileSync(path.join(directory, file)).toString("base64")]));
  const data = JSON.stringify({ before, after, images: [assets(beforeDir), assets(afterDir)], report }).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'">
<title>宠物修复前后对比</title><style>body{font:16px system-ui;margin:24px;background:#edf0f4;color:#202633}body.dark{background:#222733;color:#fafafa}button,select{font:inherit;margin:5px;padding:6px}main{display:flex;gap:32px;flex-wrap:wrap}canvas{border:1px solid #8991a0;width:192px;height:208px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:1000px}small{display:block;max-width:900px;margin:16px 0}</style>
<h1>宠物修复前后对比</h1><p>候选 · 结构检查与修改范围通过；视觉复核和原生播放需单独记录。</p>
<label>动作<select id="action"></select></label><label>接续动作<select id="next"><option value="">无</option></select></label>
<button id="pause">暂停</button><button id="restart">重新播放</button><button id="step">暂停并各进一步</button><button id="background">深浅背景</button>
<label><input type="checkbox" id="still">静止帧</label><label><input type="checkbox" id="settle">单次后停在静止帧</label>
<small>原始速度 1×，按各自清单帧序和时长播放。接续测试在首次遍历后（循环动作再循环一次）切换到下一动作。两侧各自计算边界；这只检查素材衔接，不模拟应用状态机。work-focus-loop 保持静止。缺失 staticFrame 时沿用播放器第一帧回退，并在清单中显示缺失。</small>
<main><section><h2>原包</h2><canvas id="left" width="192" height="208"></canvas><pre id="leftState"></pre></section><section><h2>修复候选</h2><canvas id="right" width="192" height="208"></canvas><pre id="rightState"></pre></section></main>
<details><summary>差异与影响动作</summary><pre id="report"></pre></details>
<script>"use strict";
const frameAt = ${frameAt.toString()};
const transitionAt = ${transitionAt.toString()};
const data = ${data};
const el = id => document.getElementById(id), manifests = [data.before,data.after];
const images = data.images.map(group => Object.fromEntries(Object.entries(group).map(([key,url])=>{const img=new Image();img.src=url;return [key,img]})));
const actions = [...new Set(manifests.flatMap(m=>Object.keys(m.animations||{})))].sort();
for(const name of actions) for(const id of ["action","next"]){const option=document.createElement("option");option.value=name;option.textContent=name;el(id).append(option)}
el("action").value=actions.includes("idle")?"idle":actions[0];el("report").textContent=JSON.stringify(data.report,null,2);
let paused=false,time=0,last=performance.now(),manual=null;
function reset(){time=0;manual=null;last=performance.now()}
for(const id of ["action","next","still","settle"])el(id).onchange=reset;
el("pause").onclick=()=>{paused=!paused;el("pause").textContent=paused?"播放":"暂停";manual=null};
el("restart").onclick=reset;el("background").onclick=()=>document.body.classList.toggle("dark");
function states(){return manifests.map(m=>transitionAt(m,el("action").value,el("next").value,time,{still:el("still").checked,settle:el("settle").checked}))}
el("step").onclick=()=>{paused=true;el("pause").textContent="播放";manual=(manual||states()).map(s=>{if(!s?.definition)return s;const d=s.definition;let index=s.index+1;if(index>=d.frames.length)index=d.loopStart??d.frames.length-1;return {...s,index,column:d.frames[index],completed:false}})};
function draw(now){if(!paused)time+=now-last;last=now;(manual||states()).forEach((s,i)=>{const canvas=el(i?"right":"left"),ctx=canvas.getContext("2d");ctx.clearRect(0,0,192,208);const img=s?.definition&&images[i][s.definition.sheet||"standard"];if(img?.complete&&img.naturalWidth&&Number.isInteger(s.column))ctx.drawImage(img,s.column*192,s.definition.row*208,192,208,0,0,192,208);el(i?"rightState":"leftState").textContent=s?JSON.stringify({action:s.action,index:s.index,column:s.column,completed:s.completed,definition:s.definition},null,2):"清单不可播放"});requestAnimationFrame(draw)}requestAnimationFrame(draw);
</script></html>`;
}
