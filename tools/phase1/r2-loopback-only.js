// Additional test-runner boundary, inherited by its test-owned Node children.
// This does not replace or modify a product network guard.
import fs from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
function check(host) {
  const value = String(host || 'localhost').toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value === '::1' || value === '::ffff:127.0.0.1' || /^127(?:\.\d{1,3}){3}$/.test(value)) return;
  if (process.env.R2_NETWORK_RESULTS) fs.appendFileSync(process.env.R2_NETWORK_RESULTS, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, host: value, refused: true }) + '\n');
  throw new Error(`R2_UNKNOWN_OUTBOUND: ${value}`);
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') { if (first.path) throw new Error('R2 unexpected IPC network path'); check(first.host); }
  else { if (typeof first === 'string' && !/^\d+$/.test(first)) throw new Error('R2 unexpected socket path'); check(typeof args[1] === 'string' ? args[1] : undefined); }
  return connect.apply(this, args);
};
dgram.Socket.prototype.send = function (...args) {
  // UDP is not needed by these local HTTP/component fixtures.
  throw new Error('R2_UNKNOWN_OUTBOUND: UDP prohibited in bounded test fixture');
};
syncBuiltinESMExports();
