// Audit-only guard. Imported by NODE_OPTIONS for isolated characterization.
// Existing fixtures may replace fetch; actual sockets remain forbidden.
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import {syncBuiltinESMExports} from 'node:module';
const blocked=()=>{throw new Error('AUDIT_EXTERNAL_NETWORK_FORBIDDEN');};
net.Socket.prototype.connect=blocked;
net.connect=blocked;
net.createConnection=blocked;
tls.connect=blocked;
dgram.createSocket=blocked;
globalThis.fetch=async()=>blocked();
globalThis.WebSocket=class {constructor(){blocked();}};
syncBuiltinESMExports();
