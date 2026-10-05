// Loaded BEFORE application modules in all director tests and dry runs.
// Hard deny outbound network, generative SDK imports and auxiliary subprocess uploads.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import child from 'node:child_process';
import { syncBuiltinESMExports, registerHooks } from 'node:module';
const attempts = [];
const deny = operation => function () { attempts.push(operation); throw new Error('OFFLINE_NETWORK_OR_PROVIDER_DENIED:' + operation); };
Object.defineProperty(globalThis, 'LUMI_OFFLINE_GUARD', { value: Object.freeze({ active: true, attempts }), configurable: false });
globalThis.fetch = deny('fetch');
for (const [api, names] of [[http, ['request', 'get']], [https, ['request', 'get']], [net, ['connect', 'createConnection']], [tls, ['connect']], [dgram, ['createSocket']]])
  for (const name of names) api[name] = deny(name);
net.Socket.prototype.connect = deny('socket.connect');
for (const name of ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
  const original = child[name];
  child[name] = function (file, ...args) {
    // ffmpeg/ffprobe remain available for pre-existing technical tests, on local inputs only.
    if (['ffmpeg', 'ffprobe'].includes(file) && !JSON.stringify(args[0]).includes('://')) return original.call(this, file, ...args);
    return deny('subprocess:' + file)();
  };
}
registerHooks({ resolve(specifier, context, nextResolve) {
  if (/^(openai|@higgsfield\/|higgsfield)/.test(specifier)) return deny('generative_sdk_import')();
  return nextResolve(specifier, context);
} });
syncBuiltinESMExports();
