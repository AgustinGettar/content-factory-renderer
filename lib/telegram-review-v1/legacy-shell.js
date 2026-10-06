// Adapter for the existing Make/Edge action contract. Never changes legacy business logic.
// Install only for registered staging sessions after callback forwarding is validated.
export function legacyMediaShell(output,session,{coverFileId}){
  if(!session.media_capable)return output;
  if(!coverFileId)throw new Error('menu_cover_file_id_required');
  return {...output,actions:(output.actions||[]).map(action=>{
    const b=action.body||{};
    if(action.method==='answerCallbackQuery')return action;
    if(['sendMessage','sendRichMessage','deleteMessage','sendPhoto','sendVideo'].includes(action.method))throw new Error('single_message_invariant');
    if(action.method==='editMessageText'){
      if(String(b.chat_id)!==String(session.chat_id)||Number(b.message_id)!==session.message_id)throw new Error('single_message_identity_mismatch');
      if(b.rich_message)throw new Error('rich_menu_requires_caption_renderer');
      if(String(b.text).length>1024)throw new Error('legacy_caption_requires_pagination');
      const body={chat_id:b.chat_id,message_id:b.message_id,media:{type:'photo',media:coverFileId,caption:b.text},reply_markup:b.reply_markup};
      return {...action,method:'editMessageMedia',body,body_json:JSON.stringify(body)};
    }
    if(!['editMessageCaption','editMessageReplyMarkup','setMyCommands','setChatMenuButton'].includes(action.method))throw new Error('unsupported_shell_action');
    return action;
  })};
}
