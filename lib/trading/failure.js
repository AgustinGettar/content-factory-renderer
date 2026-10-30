// Never log error messages, remote bodies, URLs or arbitrary stack text: any
// could contain credentials. Retain only bounded code and source locations.
export function failureDetails(error){
  const code=value=>typeof value==='string'&&/^(TRADING_|DASHBOARD_|BACKUP_|ERR_|SQLITE_|KRAKEN_|TELEGRAM_)[A-Z0-9_]{1,80}$/.test(value);
  const result={code:code(error?.message)?error.message:code(error?.code)?error.code:'TRADING_UNEXPECTED_FAILURE'};
  if(['Error','TypeError','ReferenceError','SyntaxError','RangeError'].includes(error?.name))result.error_class=error.name;
  const frames=typeof error?.stack==='string'?error.stack.split('\n').slice(1,16).flatMap(line=>{
    const match=line.match(/(?:lib\/trading\/|scripts\/)([a-z0-9_-]+\.(?:js|mjs):[0-9]+:[0-9]+)/);
    return match?[match[1]]:[];
  }).slice(0,4):[];
  if(frames.length)result.frames=frames;
  return result;
}
