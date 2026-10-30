import {TelegramTransport} from '../telegram-review-v1/runtime.js';

// Trading needs a read-only chat identity check. Keep the audiovisual transport
// and its method allowlist unchanged; this adapter cannot edit menus or webhooks.
export class TradingTelegramTransport extends TelegramTransport {
  async call(method,body,file){
    if(!['getMe','getChat','sendMessage'].includes(method))throw Error('TRADING_TELEGRAM_METHOD_FORBIDDEN');
    if(method!=='getChat')return super.call(method,body,file);
    if(file||!body||Object.keys(body).length!==1||!/^[1-9]\d+$/.test(String(body.chat_id??'')))throw Error('TRADING_PRIVATE_CHAT_REQUIRED');
    let response,payload;
    try{
      response=await this.fetch(`https://api.telegram.org/bot${this.token}/getChat`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
        redirect:'error',signal:AbortSignal.timeout(20000)
      });
      payload=await response.json();
    }catch{throw Error('TRADING_CHAT_LOOKUP_UNAVAILABLE');}
    if(!response.ok||!payload?.ok)throw Error('TRADING_CHAT_LOOKUP_REJECTED');
    return payload.result;
  }
}
