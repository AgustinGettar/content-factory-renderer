import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const ACTOR_VERSION = "lumi-expression-v1";
export const MOUTH_FILE = "assets/lumi-mouth-rest.svg";

// Speech-energy animation, not phoneme alignment. Cues are computed once in LD
// from the actual narration and frozen with the approved manifest for HD.
export function performanceFromPCM(pcm, timeline, sampleRate = 8000) {
  if (!Buffer.isBuffer(pcm) || pcm.length % 4 || sampleRate !== 8000) throw new Error("Audio de actuación inválido.");
  const samples = pcm.length / 4;
  if (!samples || samples > sampleRate * 30) throw new Error("Duración de actuación inválida.");
  const energy = Array.from({length:timeline.audio_frames}, (_, frame) => {
    const start = Math.floor(frame * sampleRate / 30), end = Math.min(samples, Math.floor((frame+1) * sampleRate / 30));
    let sum = 0;
    for (let i=start;i<end;i++) {
      const value = pcm.readFloatLE(i*4);
      if (!Number.isFinite(value)) throw new Error("Muestra de audio inválida.");
      sum += value*value;
    }
    return end > start ? Math.sqrt(sum/(end-start)) : 0;
  });
  const positive = energy.filter(e=>e>.001).sort((a,b)=>a-b);
  const threshold = Math.max(.004, (positive[Math.floor(positive.length*.65)] || 0) * .5);
  const active = energy.map((e,i)=>(e*.6+(energy[i-1]||0)*.2+(energy[i+1]||0)*.2) >= threshold);
  // Remove single-frame chatter while retaining word/syllable gaps.
  for (let i=1;i<active.length-1;i++) {
    if (active[i-1] === active[i+1] && active[i] !== active[i-1]) active[i]=active[i-1];
  }
  const talking = [];
  for (let i=0;i<active.length;i++) {
    if (!active[i]) continue;
    const start=i;
    while (i+1<active.length && active[i+1]) i++;
    talking.push([start,i+1]);
  }
  return validatePerformance({version:ACTOR_VERSION,fps:30,frames:timeline.frames,talking},timeline);
}

export function validatePerformance(value, timeline) {
  if (value?.version !== ACTOR_VERSION || value.fps !== 30 || value.frames !== timeline.frames || !Array.isArray(value.talking) || value.talking.length>450) throw new Error("Falta la actuación aprobada de Lumi.");
  let end=0;
  for (const cue of value.talking) {
    if (!Array.isArray(cue) || cue.length!==2 || !cue.every(Number.isInteger) || cue[0]<end || cue[1]<=cue[0] || cue[1]>timeline.audio_frames) throw new Error("La actuación no coincide con la narración aprobada.");
    end=cue[1];
  }
  return value;
}

export async function analyzePerformance(audioPath, timeline, timeoutMs=30000) {
  const {stdout} = await exec("ffmpeg",["-v","error","-i",audioPath,"-vn","-ac","1","-ar","8000","-f","f32le","pipe:1"],{encoding:"buffer",maxBuffer:2*1024*1024,timeout:timeoutMs});
  return performanceFromPCM(stdout,timeline);
}

export function talkingExpression(performance) {
  return performance.talking.map(([a,b])=>`gte(n,${a})*lt(n,${b})`).join("+") || "0";
}

// A fixed rig mask for the approved 561x701 artwork. Both masks are complementary
// so the resting pose preserves its pixels. The upper rectangle covers antennae;
// the convex face polygon leaves the wand, hands and wings in the body layer.
const face = [[227,124],[339,127],[378,169],[399,254],[391,301],[349,340],[288,349],[226,341],[180,321],[140,278],[145,225],[166,180]];
const faceMask = face.map(([x,y],i)=>{
  const [nextX,nextY]=face[(i+1)%face.length];
  return `gte(${nextX-x}*(Y-${y})-${nextY-y}*(X-${x}),0)`;
}).join("*");
const headMask = `gt(between(X,181,435)*lt(Y,150)+${faceMask},0)`;
export const headAlpha = `alpha(X,Y)*(${headMask})`;
export const bodyAlpha = `alpha(X,Y)*(1-(${headMask}))`;

export function headRotation(role) {
  if (role === "question") return "0.018*min(t/0.8,1)+0.004*sin(2*PI*t/4)";
  if (role === "answer") return "0.014*sin(2*PI*t/1.3)*exp(-t/3)";
  return "0.008*sin(2*PI*t/4.3)";
}
