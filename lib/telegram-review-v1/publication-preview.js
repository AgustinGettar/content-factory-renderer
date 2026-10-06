import {artifactReview,sha256} from './core.js';
const names={youtube:'YouTube Shorts',instagram:'Instagram Reels',tiktok:'TikTok'};
export function publicationPanel(s,screen,button){
 const e=s.episodes[screen.episode_id],r=e&&artifactReview(e,e.master);
 if(r?.human_status!=='MASTER_HUMAN_APPROVED'||r.status!=='APPROVED')throw Error('MASTER_HUMAN_APPROVAL_REQUIRED');
 const inventory=e.publication_inventory||[], supported=inventory.filter(p=>p.implementation_status==='IMPLEMENTED');
 const selected=(screen.platforms||[]).filter(p=>supported.some(x=>x.platform===p));
 const preview={episode_id:e.episode_id,master_sha:e.master.sha256,review_version:r.review_version,platforms:selected,title:e.publication_title||e.title,caption:e.publication_caption||'',mode:screen.mode||'private',thumbnail:e.publication_thumbnail||null,connections:Object.fromEntries(supported.map(p=>[p.platform,p.account_connection_status==='CONNECTED']))};
 const bind={sha:e.master.sha256,platforms:selected,mode:preview.mode};
 let caption,rows=[];
 if(['publish','publish_select'].includes(screen.kind)){
  caption='📤 Publicar · Elegí plataformas\n\n'+(supported.length?'':'Publicadores pendientes de habilitación.');
  rows=supported.map(p=>[button(`${selected.includes(p.platform)?'☑️':'⬜️'} ${names[p.platform]||p.platform}`,'publish_toggle',{...bind,platform:p.platform})]);
  if(selected.length)rows.push([button('🔍 Vista previa','publish_preview',bind)]);
 }else if(screen.kind==='publish_preview'){
  caption=`📤 Vista previa\n\n${preview.title}\n${preview.caption}\nPlataformas: ${selected.map(p=>names[p]||p).join(', ')||'Sin selección'}\nModo: ${preview.mode}\n${preview.thumbnail?'Miniatura registrada':'Miniatura: sin configuración'}\n\n${selected.some(p=>!preview.connections[p])?'Falta conectar la cuenta.':'La aprobación del master no publica automáticamente.'}`;
  rows=[[button('Continuar','publish_confirm',bind)]];
 }else if(screen.kind==='publish_confirm'){
  caption='Confirmar publicación\n\n'+preview.title+'\n\nLa publicación está desactivada; no se enviará ni programará contenido.';
  rows=[[button('CONFIRMAR PUBLICACIÓN','publish_commit',{...bind,preview_sha:sha256(JSON.stringify(preview))})]];
 }else {caption={publishing:'📤 Publicando',published:'✅ Publicado',publish_error:'⚠️ Error de publicación'}[screen.kind]||'📤 Publicación';caption+='\n\n'+(e.publication_status_message||'Estado de simulación; sin envíos reales.');}
 rows.push([button('⬅️ Volver','back',{return_screen:screen.return_to||{kind:'master',episode_id:e.episode_id}})],[button('🏠 Menú principal','menu')]);
 return {artifact:null,caption,text:caption,content_type:'text',reply_markup:{inline_keyboard:rows},preview};
}
