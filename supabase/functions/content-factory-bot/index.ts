import {handleUpdate,finishAI} from './core.mjs';
const url=Deno.env.get('SUPABASE_URL')!,key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
async function rest(path:string,params:Record<string,unknown>={},body?:unknown){
 const q=new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)]));
 const r=await fetch(`${url}/rest/v1/${path}?${q}`,{method:body===undefined?'GET':'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 const data=await r.json();if(!r.ok)throw new Error(r.status<500?(data.message??'Solicitud inválida'):'La base de datos no respondió. Probá nuevamente.');return data;
}
const db=(table:string,params:Record<string,unknown>={})=>rest(table,params);
const command=(user:string,chat:string,k:string,action:string,args:unknown)=>rest('rpc/cf_bot_command',{}, {p_user:user,p_chat:chat,p_key:k,p_action:action,p_args:args});
Deno.serve(async req=>{
 if(req.method!=='POST')return new Response('Method not allowed',{status:405});
 try{
  const secret=req.headers.get('x-cf-secret')??'';
  if(secret.length<40)return new Response('Unauthorized',{status:401});
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret)))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const [settings]=await db('cf_bot_settings',{id:'eq.true',select:'secret_hash'});
  if(!settings||hash!==settings.secret_hash)return new Response('Unauthorized',{status:401});
  const text=await req.text();if(text.length>262144)return new Response('Payload too large',{status:413});
  const input=JSON.parse(text),job=req.headers.get('x-cf-job');
  if(job&&!/^[a-f0-9-]{36}$/.test(job))return new Response('Invalid job',{status:400});
  const output=job?await finishAI(job,input,{db,command}):await handleUpdate(input,{db,command});
  // Make's mapping language has no toJSON function. Emit ready-to-send JSON.
  output.actions=output.actions.map((a:any)=>({...a,body_json:JSON.stringify(a.body)}));
  if(output.ai)output.ai.request_json=JSON.stringify(output.ai.request);
  return Response.json(output);
 }catch{console.error('Content Factory bot request failed');return Response.json({error:'Temporary failure'},{status:503});}
});
