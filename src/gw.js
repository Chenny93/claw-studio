// 极简 OpenClaw Gateway WS 客户端（仅本机 loopback）
const fs = require('fs');
const { STATE, GW_PORT } = require('./config');

function readToken() {
  const t = fs.readFileSync(STATE + '\\openclaw.json', 'utf8');
  const m = t.match(/gateway[\s\S]*?auth[\s\S]*?token["']?\s*:\s*["']([^"']+)["']/);
  if (!m) throw new Error('gateway token not found');
  return m[1];
}
const readPort = GW_PORT;

class Gateway {
  constructor() { this.ws = null; this.ready = null; this.pending = new Map(); this.seq = 0; this.listeners = new Set(); this.hello = null; }
  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const port = readPort();
      const ws = new WebSocket('ws://127.0.0.1:' + port, { headers: { Origin: 'http://127.0.0.1:' + port } });
      this.ws = ws;
      let done = false;
      const fail = e => { if (!done) { done = true; reject(e); } this.ready = null; };
      ws.onerror = e => fail(new Error('ws error ' + (e.message || '')));
      ws.onclose = () => { this.ready = null; for (const p of this.pending.values()) p.reject(new Error('gateway closed')); this.pending.clear(); fail(new Error('closed')); };
      ws.onmessage = ev => {
        let f; try { f = JSON.parse(ev.data); } catch { return; }
        if (f.type === 'event' && f.event === 'connect.challenge') {
          this._raw('connect', {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'openclaw-control-ui', version: '1.0.0', platform: 'win32', mode: 'webchat' },
            role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'],
            caps: [], commands: [], permissions: {}, auth: { token: readToken() },
            locale: 'zh-CN', userAgent: 'claw-studio/1.0'
          }).then(r => { done = true; this.hello = r; resolve(r); }, fail);
          return;
        }
        if (f.type === 'res') {
          const p = this.pending.get(f.id); if (!p) return;
          this.pending.delete(f.id);
          f.ok ? p.resolve(f.payload) : p.reject(new Error((f.error && f.error.message) || JSON.stringify(f.error || f)));
          return;
        }
        if (f.type === 'event') for (const l of this.listeners) { try { l(f); } catch {} }
      };
    });
    return this.ready;
  }
  _raw(method, params, timeoutMs) {
    const id = 'sm' + (++this.seq);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, timeoutMs || 60000);
    });
  }
  async call(method, params, timeoutMs) { await this.connect(); return this._raw(method, params, timeoutMs); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
module.exports = new Gateway();
