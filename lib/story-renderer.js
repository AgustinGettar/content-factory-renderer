import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { COLORS, validateProduction, verifyTimeline } from "./story-timeline.js";
const exec = promisify(execFile);
export const CHARACTER_FILES = ["assets/lumi-canonical-wand.png", "assets/lumi-canonical-wand-blink.png"];

const star = (x, y, r, color) => {
  const points = Array.from({length:10}, (_, i) => {
    const a = -Math.PI / 2 + i * Math.PI / 5, radius = i % 2 ? r * .46 : r;
    return `${x + Math.cos(a) * radius},${y + Math.sin(a) * radius}`;
  }).join(" ");
  return `<polygon points="${points}" fill="${color}" stroke="white" stroke-width="5" stroke-linejoin="round"/>`;
};

// Exact educational geometry. Text is painted separately from UTF-8 files;
// model output is never interpolated as SVG or an FFmpeg expression.
export function focusSVG(focus) {
  const color = COLORS[focus.color];
  if (focus.kind === "label") return '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="460"/>';
  let inside = "";
  if (focus.kind === "count") {
    const count = Number(focus.value), cols = Math.min(count, 5), rows = Math.ceil(count / 5);
    for (let i=0;i<count;i++) {
      const row = Math.floor(i/5), rowCount = Math.min(5, count-row*5);
      inside += star(450 + ((i % 5)-(rowCount-1)/2)*145, 235 + (row-(rows-1)/2)*145, 59, color);
    }
  } else if (focus.kind === "color" || (focus.kind === "shape" && focus.value.toLowerCase() === "círculo")) {
    inside = `<circle cx="450" cy="240" r="128" fill="${color}" stroke="white" stroke-width="12"/>`;
  } else if (focus.kind === "shape" && focus.value.toLowerCase() === "cuadrado") {
    inside = `<rect x="315" y="105" width="270" height="270" fill="${color}" stroke="white" stroke-width="12"/>`;
  } else if (focus.kind === "shape") {
    inside = `<polygon points="450,92 292,366 608,366" fill="${color}" stroke="white" stroke-width="12" stroke-linejoin="round"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="460" viewBox="0 0 900 460"><rect x="8" y="20" width="884" height="432" rx="64" fill="#49386B" opacity=".12"/><rect x="8" y="5" width="884" height="432" rx="64" fill="#FFFDF7" stroke="#FFFFFF" stroke-width="8"/>${inside}</svg>`;
}

function filterPath(value) {
  // Only private temp paths and the installed font path enter the graph.
  if (/[\n\r'\[\],;\\:]/.test(value)) throw new Error("Ruta de render no compatible.");
  return value;
}

export async function renderStoryScene({ imagePath, audioPath, textPath, outputPath, profile, production, timeline, characterFiles = CHARACTER_FILES, fontPath = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", timeoutMs = 900000 }) {
  const p = validateProduction(production);
  verifyTimeline(timeline, timeline.audio_seconds, p);
  const {width:w, height:h, fps} = profile, px = n => Math.round(n * w / 1080);
  const folder = path.dirname(outputPath), focusPath = path.join(folder, "focus.svg"), labelPath = path.join(folder, "focus.txt"), magicPath = path.join(folder, "magic.svg");
  await fs.writeFile(focusPath, focusSVG(p.focus));
  await fs.writeFile(labelPath, p.focus.value);
  await fs.writeFile(magicPath, `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">${star(80,80,67,"#FFE49A")}</svg>`);
  [fontPath,textPath,labelPath].forEach(filterPath);
  const d = timeline.duration_seconds, frames = timeline.frames;
  const args = ["-y","-threads","1","-filter_complex_threads","1"];
  const still = file => args.push("-loop","1","-framerate",String(fps),"-t",String(d),"-i",file);
  still(imagePath); args.push("-i",audioPath);
  for (const file of characterFiles) still(path.resolve(file));
  still(focusPath); still(magicPath);
  const graph = [];
  graph.push(`[0:v]scale=${w*2}:${h*2}:force_original_aspect_ratio=increase,crop=${w*2}:${h*2},zoompan=z='1.025+0.012*(1-cos(PI*on/${Math.max(1,frames-1)}))':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${w}x${h}:fps=${fps},setsar=1[bg]`);
  // Both sprite poses use identical transforms and a deterministic blink clock.
  for (const [index,name] of [[2,"open"],[3,"blink"]]) {
    graph.push(`[${index}:v]format=rgba,scale=-1:${px(890)},rotate='0.008*sin(2*PI*t/4.8)':c=none:ow=iw:oh=ih[${name}]`);
  }
  const xpos = `(W-w)/2+${px(7)}*sin(2*PI*t/5.2)`, ypos = `${px(915)}+${px(6)}*sin(2*PI*t/3.8)`;
  graph.push(`[bg][open]overlay=x='${xpos}':y='${ypos}':format=auto[host]`);
  graph.push(`[host][blink]overlay=x='${xpos}':y='${ypos}':enable='lt(mod(t+1.1,3.7),0.13)':format=auto[blinking]`);
  const textFocus = ["label","letter"].includes(p.focus.kind);
  const focusText = textFocus ? `,drawtext=fontfile='${fontPath}':textfile='${labelPath}':expansion=none:fontcolor=0x493A69:borderw=5:bordercolor=white:fontsize=${p.focus.kind === "letter" ? 230 : Math.min(110, Math.floor(1250/[...p.focus.value].length))}:x=(w-tw)/2:y=${p.focus.kind === "label" ? "h-th-20" : "(h-th)/2"}` : "";
  graph.push(`[4:v]format=rgba${focusText},scale=${px(880)}:-1,fade=t=in:st=0:d=0.2:alpha=1[focus]`);
  graph.push(`[blinking][focus]overlay=x=(W-w)/2:y='${px(350)}+${px(35)}*exp(-8*t)':format=auto[stage]`);
  let last = "stage";
  if (p.role === "answer" && p.focus.kind !== "count") {
    graph.push(`[5:v]format=rgba,scale=${px(74)}:-1,fade=t=in:st=0:d=0.1:alpha=1,fade=t=out:st=0.9:d=0.35:alpha=1[magic]`);
    graph.push(`[stage][magic]overlay=x='${px(340)}+${px(155)}*min(t,1)':y='${px(1190)}-${px(435)}*min(t,1)':enable='lt(t,1.25)':format=auto[celebrate]`);
    last = "celebrate";
  } else {
    graph.push("[5:v]nullsink");
  }
  const caption = await fs.readFile(textPath,"utf8");
  if (caption.trim()) {
    graph.push(`[${last}]drawtext=fontfile='${fontPath}':textfile='${textPath}':expansion=none:fontcolor=0x423358:fontsize=${px(66)}:borderw=${px(7)}:bordercolor=white:line_spacing=${px(15)}:x=(w-tw)/2:y=${px(156)},format=yuv420p[v]`);
  } else graph.push(`[${last}]format=yuv420p[v]`);
  // Audio remains at native speed. Pad actual silence AFTER speech, then trim
  // both streams to the exact common frame clock; do not use -shortest.
  graph.push(`[1:a]aresample=48000,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a]`);
  const intermediate = path.extname(outputPath) === ".mkv";
  args.push("-filter_complex",graph.join(";"),"-map","[v]","-map","[a]","-c:v","libx264","-threads","1","-preset","veryfast","-crf",String(profile.crf),"-r",String(fps),"-t",String(d),"-c:a",intermediate ? "pcm_s16le" : "aac",...(!intermediate ? ["-b:a",profile.audioBitrate] : []),"-ar","48000","-ac","2",...(!intermediate ? ["-movflags","+faststart"] : []),outputPath);
  await exec("ffmpeg",args,{timeout:timeoutMs,maxBuffer:10*1024*1024});
}
