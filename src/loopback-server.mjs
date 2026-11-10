import { randomInt } from 'node:crypto';

// Fixed so external programs can keep one address. 47821 is IANA-unassigned
// (47810-47999), above this machine family's custom ephemeral ranges and the
// Fetch bad-port list. --port wins, then COOP_PORT; 0 means a random port.
export const DEFAULT_PORT = 47821;
export function servePort(option, env = process.env) {
  const value = option ?? env.COOP_PORT;
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须是 0 到 65535 之间的整数。');
  return port;
}

// A custom Windows ephemeral range may include Fetch-blocked ports such as
// 6000, 6667 and 10080. Pick only usable loopback HTTP ports, without changing
// the machine's range, and retry ordinary local bind conflicts.
export async function listenLoopback(server, choosePort = () => randomInt(20000, 65536)) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const port = choosePort();
    if (!Number.isInteger(port) || port < 20000 || port > 65535) throw new Error('Invalid automatic loopback port.');
    try {
      await new Promise((ok, fail) => {
        const error = e => { server.off('listening', ready); fail(e); };
        const ready = () => { server.off('error', error); ok(); };
        server.once('error', error); server.once('listening', ready);
        server.listen(port, '127.0.0.1');
      });
      return;
    } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error; }
  }
  throw new Error('No available local HTTP port.');
}
