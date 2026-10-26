import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {clone,instance,normalize,RATE} from '../public/lumi-studio/editor-model.js';

// Reuses the real Studio/EditorStore fixture in lumi-simple-studio-browser.mjs.
// CDP touch is a Chromium check, never a claim about a physical iPhone.
export async function editorTouchChecks({page,context,editor,principal,base,out,before=false}){
 const folder=join(out,before?'touch-before':'touch-after');await mkdir(folder,{recursive:true});
 const job=await editor.import(principal,{episode_id:'fixture',command_id:'touch-polish'});await editor.processPending('1');
 let project=await editor.get(principal,job.id),edit=clone(project.revision.edit);
 const video=Object.values(project.sources).find(s=>s.video),voice=Object.values(project.sources).find(s=>s.audio&&!s.video);
 for(let n=1;n<4;n++)edit.clips.push(instance(video,'video',n*video.video_ticks,'touch_video_'+n));
 edit.clips.push({...instance(voice,'voice',.6*RATE,'touch_voice'),gain_mdb:-3000});edit=normalize(edit);
 await editor.save(principal,project.id,{base_revision:project.current,command_id:'seed-touch',edit,fork:false});
 await page.setViewportSize({width:390,height:844});await page.goto(base+'/lumi/studio#editor');
 const chooser=page.locator('[data-editor-project]');await chooser.waitFor({state:'attached'});await chooser.evaluate(e=>{for(let p=e.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});await chooser.selectOption(project.id);
 await page.waitForFunction(()=>document.querySelector('[data-editor-stage] video')?.readyState>=2);await page.locator('[data-editor-more]').evaluate(e=>e.open=false);
 const touch=await context.newCDPSession(page),evidence={before,environment:'Chromium CDP touch, loopback, real handlers, isolated 20 s timeline / 5 s synthetic source; NOT_IPHONE'};
 const position=async()=>Number(await page.locator('[data-editor-seek]').inputValue())/RATE;
 const seek=async seconds=>{await page.locator('[data-editor-seek]').evaluate((e,n)=>{e.value=String(n*48000);e.dispatchEvent(new Event('input',{bubbles:true}));},seconds);await page.waitForTimeout(100);};
 const zoom=async value=>{await page.locator('[data-editor-zoom]').evaluate((e,n)=>{e.value=String(n);e.dispatchEvent(new Event('input',{bubbles:true}));},value);};
 const gesture=async(x,y,toX,toY=y)=>{await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let i=1;i<=8;i++){await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+(toX-x)*i/8,y:y+(toY-y)*i/8}]});await page.waitForTimeout(16);}await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(80);};
 const shot=async name=>{await page.evaluate(()=>document.activeElement?.blur());await page.screenshot({path:join(folder,name+'.png'),fullPage:true});};
 await seek(1);await zoom(55);await page.locator('.edit-scroll').evaluate(e=>e.scrollLeft=0);await shot('editor');
 evidence.hit_area=await page.evaluate(()=>{const grip=document.querySelector('[data-editor-cursor]')||document.querySelector('.edit-cursor'),ruler=document.querySelector('.edit-ruler');return {grip_width:grip.getBoundingClientRect().width,grip_height:grip.getBoundingClientRect().height,ruler_height:ruler.getBoundingClientRect().height};});
 await page.locator('.edit-ruler').evaluate(e=>e.scrollIntoView({block:'center'}));
 let ruler=await page.locator('.edit-ruler').boundingBox(),padding=before?0:22;
 await gesture(ruler.x+padding+3*55,ruler.y+14,ruler.x+padding+4*55);
 evidence.ruler_drag={target_seconds:4,actual_seconds:await position()};
 if(!before){assert.ok(Math.abs(await position()-4)<.04,'ruler drag follows the finger');assert.ok(evidence.hit_area.grip_width>=44&&evidence.hit_area.grip_height>=44);}
 await seek(10);await page.locator('.edit-scroll').evaluate(e=>e.scrollLeft=400);
 const cursorX=()=>page.locator('.edit-cursor').evaluate(e=>e.getBoundingClientRect().x);
 const oldX=await cursorX();await zoom(110);evidence.zoom_anchor_drift_px=Math.abs(await cursorX()-oldX);
 if(!before)assert.ok(evidence.zoom_anchor_drift_px<2,'zoom retains the visible cursor anchor');
 await zoom(55);await seek(1);await page.locator('.edit-scroll').evaluate(e=>e.scrollLeft=0);await page.locator('[data-clip=touch_voice]').click();
 const slider=page.locator('[data-edit-slider=timeline_start]');await slider.evaluate(e=>{e.value='1.25';e.dispatchEvent(new Event('input',{bubbles:true}));});
 evidence.live_slider_label=await slider.locator('..').locator('output').innerText();if(!before)assert.equal(evidence.live_slider_label,'1.25 s');
 await slider.evaluate(e=>{e.value='.6';e.dispatchEvent(new Event('input',{bubbles:true}));});await shot('audio');
 evidence.short_clip_handles=await page.locator('[data-clip=touch_voice] [data-handle]:visible').count();if(!before)assert.equal(evidence.short_clip_handles,0,'short audio keeps a clear move/select area');
 await seek(2);await page.waitForFunction(()=>Math.abs(document.querySelector('[data-editor-stage] video').currentTime-2)<.05);await seek(20);await page.waitForTimeout(200);
 evidence.preview_at_end_seconds=await page.locator('[data-editor-stage] video').evaluate(e=>e.currentTime);
 if(!before)assert.ok(evidence.preview_at_end_seconds>4.9,'exact end seeks to the final video frame');
 if(!before){
  const currentRevision=async()=>(await editor.get(principal,project.id)).current;
  const revisionBefore=await currentRevision();
  // Native overview slider: the physical thumb, not an injected input value.
  await seek(0);const range=page.locator('[data-editor-seek]');await range.scrollIntoViewIfNeeded();let box=await range.boundingBox();await gesture(box.x+22,box.y+22,box.x+22+(box.width-44)/2);evidence.native_seek_seconds=await position();assert.ok(Math.abs(await position()-10)<.08);
  // The grip accepts a finger away from its centre without jumping on contact.
  await zoom(110);await seek(2);await page.locator('.edit-scroll').evaluate(e=>e.scrollLeft=0);await page.locator('.edit-ruler').evaluate(e=>e.scrollIntoView({block:'center'}));box=await page.locator('[data-editor-cursor]').boundingBox();
  const gx=box.x+38,gy=box.y+22;await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:gx,y:gy}]});await page.waitForTimeout(60);assert.ok(Math.abs(await position()-2)<.04,'off-centre grab does not jump');
  for(let i=1;i<=8;i++){await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:gx+44*i/8,y:gy}]});await page.waitForTimeout(16);}await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});evidence.off_centre_grip_seconds=await position();assert.ok(Math.abs(await position()-2.4)<.04);
  // An unselected clip pans the timeline; it never reorders the video.
  await zoom(55);await seek(1);await page.locator('.edit-scroll').evaluate(e=>e.scrollLeft=0);box=await page.locator('[data-lane=video] [data-clip]').first().boundingBox();await gesture(box.x+200,box.y+26,box.x+90);evidence.pan_scroll_px=await page.locator('.edit-scroll').evaluate(e=>e.scrollLeft);assert.ok(evidence.pan_scroll_px>100);assert.equal(await currentRevision(),revisionBefore);
  // Following the cursor across the right edge is bounded to this gesture.
  await page.locator('.edit-scroll').evaluate(e=>e.scrollLeft=0);await seek(2);box=await page.locator('[data-editor-cursor]').boundingBox();const view=await page.locator('.edit-scroll').boundingBox();await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+22,y:box.y+22}]});await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:view.x+view.width-6,y:box.y+22}]});await page.waitForTimeout(300);await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});evidence.edge_scroll_px=await page.locator('.edit-scroll').evaluate(e=>e.scrollLeft);assert.ok(evidence.edge_scroll_px>40);const stoppedAt=await position();await page.waitForTimeout(100);assert.equal(await position(),stoppedAt,'release ends edge scrolling');
  // Select, move a short voice, receive autosave, undo, and cancel a later drag.
  await zoom(160);await seek(1);await page.locator('.edit-scroll').evaluate(e=>e.scrollLeft=0);await page.locator('[data-clip=touch_voice]').click();box=await page.locator('[data-clip=touch_voice]').boundingBox();await gesture(box.x+box.width/2,box.y+26,box.x+box.width/2+96);assert.equal(await page.locator('[data-edit-slider=timeline_start]').inputValue(),'1.2');await page.waitForFunction(()=>document.querySelector('[data-editor-status]').textContent.startsWith('Guardado'));
  await page.locator('[data-edit-action=undo]').click();assert.equal(await page.locator('[data-edit-slider=timeline_start]').inputValue(),'0.6');await page.waitForFunction(()=>document.querySelector('[data-editor-status]').textContent.startsWith('Guardado'));let revisionAfterUndo=await currentRevision();
  box=await page.locator('[data-clip=touch_voice]').boundingBox();const vx=box.x+box.width/2,vy=box.y+26;await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:vx,y:vy}]});await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:vx+48,y:vy}]});await touch.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});assert.equal(await page.locator('[data-edit-slider=timeline_start]').inputValue(),'0.6');
  // An earlier edit may autosave while a later drag is still transient.
  await page.locator('[data-edit-field=gain_mdb]').evaluate(e=>{e.value='-2';e.dispatchEvent(new Event('change',{bubbles:true}));});
  box=await page.locator('[data-clip=touch_voice]').boundingBox();const ax=box.x+box.width/2,ay=box.y+26;await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:ax,y:ay}]});await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:ax+48,y:ay}]});await page.waitForTimeout(1200);
  const during=(await editor.get(principal,project.id)).revision.edit.clips.find(c=>c.id==='touch_voice');assert.equal(during.gain_mdb,-2000);assert.equal(during.timeline_start,.6*RATE,'autosave must not persist an unfinished drag');
  await touch.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});assert.equal(await page.locator('[data-edit-slider=timeline_start]').inputValue(),'0.6');await page.locator('[data-edit-action=undo]').click();assert.equal(await page.locator('[data-edit-field=gain_mdb]').inputValue(),'-3');await page.waitForFunction(()=>document.querySelector('[data-editor-status]').textContent.startsWith('Guardado'));revisionAfterUndo=await currentRevision();evidence.autosave_during_drag='previous gain received; unfinished offset excluded; cancel and undo preserved';
  // A second finger rolls back an unfinished clip edit before zooming.
  await zoom(100);await page.locator('.edit-scroll').evaluate(e=>e.scrollLeft=0);box=await page.locator('[data-clip=touch_voice]').boundingBox();const px=box.x+box.width/2,py=box.y+26;
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:px,y:py}]});await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:px+20,y:py}]});await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:px+20,y:py},{id:2,x:px+110,y:py}]});await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:px,y:py},{id:2,x:px+135,y:py}]});await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.equal(await page.locator('[data-edit-slider=timeline_start]').inputValue(),'0.6');evidence.pinch_zoom=Number(await page.locator('[data-editor-zoom]').inputValue());assert.ok(evidence.pinch_zoom>100);await page.waitForTimeout(1100);assert.equal(await currentRevision(),revisionAfterUndo,'cancelled edits and pinch do not autosave');
  // Keyboard precision, compact ruler spacing, and restored view on return.
  await seek(0);const grip=page.locator('[data-editor-cursor]');await grip.focus();await grip.press('ArrowRight');assert.equal(Number(await page.locator('[data-editor-seek]').inputValue()),1600);await grip.press('End');assert.equal(await position(),20);
  await zoom(20);assert.equal(await page.locator('.edit-ruler span').nth(1).innerText(),'2s');await zoom(110);await seek(10);const scrollBeforeBack=await page.locator('.edit-scroll').evaluate(e=>e.scrollLeft);await page.locator('[data-edit-action=back]').click();await page.locator('[data-open-editor]').first().click();await page.locator('[data-clip=touch_voice]').waitFor();assert.equal(await position(),10);assert.ok(Math.abs(await page.locator('.edit-scroll').evaluate(e=>e.scrollLeft)-scrollBeforeBack)<2);assert.equal(await page.locator('[data-clip=touch_voice]').getAttribute('aria-pressed'),'true');
  const aligned=async()=>assert.ok(await page.locator('.edit-transport .button').evaluateAll(nodes=>{const [a,b]=nodes.map(n=>n.getBoundingClientRect());return Math.abs(a.top-b.top)<1&&Math.abs(a.height-b.height)<1;}),'transport buttons stay aligned');
  for(const [width,height] of [[360,780],[390,844],[430,932],[844,390]]){await page.setViewportSize({width,height});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await aligned();}
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.documentElement.style.fontSize='125%');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await aligned();await shot('texto-ampliado');await page.evaluate(()=>document.documentElement.style.fontSize='');
  evidence.editing='touch pan without edits; short voice +0.600 s, receipt, undo; pointercancel and pinch rollback without extra revision; keyboard frame/end; return preserves selection, position and viewport';
 }
 evidence.pass=true;await writeFile(join(folder,'browser.json'),JSON.stringify(evidence,null,2));return evidence;
}
