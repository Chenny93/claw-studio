// Claw 会话管理器 v2
// - 会话数据：只读 OpenClaw sessions.json + *.jsonl
// - 改名/置顶：本目录 meta.json
// - 发消息/模型/技能/定时任务：本机 OpenClaw 网关 WebSocket（与 Claw 原界面同一通道）
const http = require('http'), fs = require('fs'), path = require('path');
const gw = require('./gw');
const C = require('./config');
const { STATE, SDIR, WORKSPACE, LOGDIR, CLAW_EXE, ASAR, PORT } = C;
fs.mkdirSync(C.DATA_DIR, { recursive: true });
const UPLOADS = path.join(C.DATA_DIR, 'uploads');
const META = path.join(C.DATA_DIR, 'meta.json');
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

const loadMeta = () => { try { return JSON.parse(fs.readFileSync(META, 'utf8')); } catch { return {}; } };
const saveMeta = m => { const tmp = META + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8'); fs.renameSync(tmp, META); };
const loadIndex = () => JSON.parse(fs.readFileSync(path.join(SDIR, 'sessions.json'), 'utf8'));

// ---------- 转录解析 ----------
function cleanUser(t) {
  // 1) 网关注入的 "System: [...] Exec completed ..." 等系统事件行（出现在用户消息开头）
  const si = t.search(/Sender \(untrusted metadata\):/);
  if (/^System: \[/.test(t)) t = si >= 0 ? t.slice(si) : t.replace(/^(System: \[[^\n]*\n?)+/, '');
  // 2) Sender 元数据块（可能不在开头）
  t = t.replace(/Sender \(untrusted metadata\):\s*```[\s\S]*?```\s*/g, '');
  // 3) 时间戳前缀
  t = t.replace(/^\s*\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\]\s*/, '');
  return t.trim();
}
// 把 "[Attached files]\n路径..." 拆出来，单独以文件卡片显示
function splitAttached(t) {
  const i = t.indexOf('[Attached files]');
  if (i < 0) return { text: t, files: [] };
  const files = t.slice(i + 16).split('\n').map(s => s.trim()).filter(s => /^[A-Za-z]:\\/.test(s));
  return { text: t.slice(0, i).trim(), files };
}
// 从文本里找出存在于磁盘上的本地图片路径（如 [Attached files] / MEDIA: 行）
function findImagePaths(t) {
  const out = new Set();
  const re = /(?:MEDIA:)?([A-Za-z]:\\[^\r\n"<>|*?]+?\.(?:png|jpe?g|gif|webp|bmp))/gi;
  let m; while ((m = re.exec(t))) { const p = m[1].replace(/\\\\/g, '\\'); try { if (fs.statSync(p).isFile()) out.add(p); } catch {} }
  return [...out];
}
function parseEntry(e) {
  const msg = e.message; const role = msg.role;
  let text = '', images = [];
  const c = msg.content;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) for (const p of c) {
    if (p.type === 'text') text += (text ? '\n' : '') + p.text;
    else if (p.type === 'image' && p.data) images.push({ src: 'data:' + (p.mimeType || 'image/png') + ';base64,' + p.data });
  }
  let attached = [];
  if (role === 'user') { text = cleanUser(text); const s = splitAttached(text); text = s.text; attached = s.files; }
  const paths = findImagePaths(text + '\n' + attached.join('\n'));
  // 内嵌 base64 图片通常与 [Attached files] 里的路径一一对应；有内嵌就不重复显示路径图
  if (!images.length) for (const p of paths) images.push({ src: '/api/file?path=' + encodeURIComponent(p), path: p });
  const files = attached.filter(p => !IMG_EXT.test(p)).map(p => { let size = null; try { size = fs.statSync(p).size; } catch {} return { path: p, name: p.split('\\').pop(), size }; });
  return { role, text, images, files, ts: e.timestamp };
}
// 工具调用：assistant.toolCall + toolResult 按顺序归到下一条 Claw 文字回复上（截断，避免前端过大）
const clip = (x, n) => { const t = typeof x === 'string' ? x : JSON.stringify(x); return t.length > n ? t.slice(0, n) + '\n…（共 ' + t.length.toLocaleString() + ' 字符，已截断）' : t; };
function readTranscript(file, limitFirst) {
  const out = [];
  if (!file || !fs.existsSync(file)) return out;
  let tools = [], byId = {};
  const flush = ts => { if (tools.length) { out.push({ role: 'assistant', text: '', images: [], files: [], ts, tools }); tools = []; byId = {}; } };
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    if (!limitFirst && m.role === 'toolResult') {
      const t = byId[m.toolCallId]; const txt = Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : String(m.content || '');
      if (t) { t.result = clip(txt, 3000); t.resultLen = txt.length; t.error = !!m.isError; }
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!limitFirst && m.role === 'assistant' && Array.isArray(m.content))
      for (const c of m.content) if (c.type === 'toolCall') { const t = { id: c.id, name: c.name, args: clip(c.arguments || {}, 1500), ts: e.timestamp }; tools.push(t); byId[c.id] = t; }
    if (m.role === 'user') flush(e.timestamp);
    const r = parseEntry(e);
    if (!r.text.trim() && !r.images.length && !r.files.length) continue;
    if (m.role === 'assistant' && tools.length) { r.tools = tools; tools = []; byId = {}; }
    out.push(r);
    if (limitFirst && out.length >= limitFirst) break;
  }
  flush(Date.now());
  return out;
}

// 每轮起始成本：来自 sessions.json 的 systemPromptReport（字符数）+ 最近一次实际 usage
function ctxCost(key) {
  const v = loadIndex()[key]; if (!v) return null;
  const r = v.systemPromptReport || null;
  let last = null; try { const file = v.sessionFile || path.join(SDIR, v.sessionId + '.jsonl'); const st = fs.statSync(file), len = Math.min(st.size, 400000), b = Buffer.alloc(len), fd = fs.openSync(file, 'r'); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
    for (const l of b.toString('utf8').split('\n')) { if (!l.includes('"usage"')) continue; try { const m = JSON.parse(l).message; if (m && m.role === 'assistant' && m.usage) last = m.usage; } catch {} } } catch {}
  if (!r) return { report: null, last };
  const sp = r.systemPrompt || {}, files = (r.injectedWorkspaceFiles || []).filter(f => !f.missing).map(f => ({ name: f.name, chars: f.injectedChars || 0, raw: f.rawChars || 0, truncated: !!f.truncated }));
  const skills = (r.skills && r.skills.entries || []).map(k => ({ name: k.name, chars: k.blockChars || 0 })).sort((a, b) => b.chars - a.chars);
  const tools = (r.tools && r.tools.entries || []).map(t => ({ name: t.name, chars: (t.summaryChars || 0) + (t.schemaChars || 0) })).sort((a, b) => b.chars - a.chars);
  const fileChars = files.reduce((a, f) => a + f.chars, 0), skillChars = (r.skills && r.skills.promptChars) || 0, toolChars = ((r.tools && r.tools.schemaChars) || 0);
  return { report: { at: r.generatedAt, model: r.model, total: (sp.chars || 0) + toolChars, systemChars: sp.chars || 0, fileChars, skillChars, toolChars,
    otherChars: Math.max(0, (sp.chars || 0) - fileChars - skillChars), files, skills, tools, maxPerFile: r.bootstrapMaxChars, truncated: (r.bootstrapTruncation || {}).truncatedFiles || 0 }, last };
}

const previewCache = {};
function listSessions() {
  const idx = loadIndex(), meta = loadMeta();
  return Object.entries(idx).map(([key, v]) => {
    const file = v.sessionFile || path.join(SDIR, v.sessionId + '.jsonl');
    let st = null; try { st = fs.statSync(file); } catch {}
    const ck = file + ':' + (st ? st.mtimeMs : 0);
    if (!(ck in previewCache)) { const f = readTranscript(file, 1)[0]; previewCache[ck] = f ? (f.text || '[图片]').slice(0, 160) : ''; }
    const m = meta[key] || {};
    const created = (key.match(/chat-(\d{13})/) || [])[1];
    return {
      key, sessionId: v.sessionId, label: v.label || '', name: m.name || '', pinned: !!m.pinned,
      preview: previewCache[ck], updatedAt: v.updatedAt || 0, createdAt: created ? +created : null,
      model: v.modelOverride || v.model || '', provider: v.providerOverride || v.modelProvider || '', tokens: v.totalTokens || 0, size: st ? st.size : 0,
      ctxUsed: v.totalTokens || 0, ctxMax: v.contextTokens || 0, compactions: v.compactionCount || 0,
      kind: key.includes(':subagent:') ? 'subagent' : key.includes(':cron:') ? 'cron' : key.endsWith(':main') ? 'main' : 'chat', parent: v.spawnedBy || ''
    };
  }).sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
}

// ---------- 版本 / 积分 ----------
let clawVersion = null;
function getClawVersion() {
  if (clawVersion) return clawVersion;
  try {
    let ofs = fs; try { ofs = require('original-fs'); } catch {}   // Electron 下 .asar 被当成目录
    process.noAsar = true;
    const buf = ofs.readFileSync(ASAR), all = [];
    process.noAsar = false;
    const needle = Buffer.from('"version": "0.1.');
    for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) {
      const m = buf.slice(i, i + 30).toString('utf8').match(/"version": "(0\.1\.\d+)"/); if (m) all.push(m[1]);
    }
    clawVersion = all.sort((a, b) => +a.split('.')[2] - +b.split('.')[2]).pop() || '未知';
  } catch { clawVersion = '未知'; }
  return clawVersion;
}
function getCredit() {
  // Claw 每次刷新用户信息都会写一条 "Benefits fetched successfully" 日志，取最新一条
  try {
    const files = fs.readdirSync(LOGDIR).filter(f => f.startsWith('app.log')).map(f => ({ f, t: fs.statSync(path.join(LOGDIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(0, 48)) {
      const txt = fs.readFileSync(path.join(LOGDIR, f), 'utf8');
      const i = txt.lastIndexOf('Benefits fetched successfully:');
      if (i < 0) continue;
      const line = txt.slice(i, txt.indexOf('\n', i) > 0 ? txt.indexOf('\n', i) : undefined);
      const ts = (txt.slice(txt.lastIndexOf('\n', i) + 1, i).match(/\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/) || [])[1];
      const j = JSON.parse(line.slice(line.indexOf('{')));
      return { balance: j.credit_balance, membership: j.membership_type, unlimited: j.is_unlimited, at: ts };
    }
  } catch (e) { return { error: e.message }; }
  return { error: '日志里暂无积分记录（打开一次 Claw 主界面会刷新）' };
}

// ---------- Claw 新版本检测 ----------
// Claw 自己每 30 分钟查一次更新并把安装包自动下载到 %LOCALAPPDATA%\genclaw-updater\pending；
// 这里只读它的日志和下载目录，不自己联网、不需要登录凭据。
const UPD_DIR = C.UPD_DIR;
const vnum = v => (v || '0').split('.').map(Number).reduce((a, x) => a * 10000 + (x || 0), 0);
function getClawUpdate() {
  const cur = getClawVersion();
  const r = { current: cur, latest: cur, available: false, ready: false, checkedAt: null, releaseDate: null };
  try {
    const files = fs.readdirSync(LOGDIR).filter(f => f.startsWith('app.log')).map(f => ({ f, t: fs.statSync(path.join(LOGDIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    outer: for (const { f } of files.slice(0, 72)) {
      const lines = fs.readFileSync(path.join(LOGDIR, f), 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        const ts = (l.match(/^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/) || [])[1];
        let m;
        if ((m = l.match(/\[Update\] Update available: v([\d.]+)/))) {
          r.checkedAt = ts; r.latest = m[1];
          for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) { const d = lines[j].match(/Release date: (\S+)/); if (d) r.releaseDate = d[1]; }
          break outer;
        }
        if (/\[Update\] No update available/.test(l)) { r.checkedAt = ts; break outer; }
      }
    }
  } catch {}
  // 已下载好的安装包
  try {
    const info = JSON.parse(fs.readFileSync(path.join(UPD_DIR, 'update-info.json'), 'utf8'));
    const v = (info.fileName.match(/(\d+\.\d+\.\d+)/) || [])[1];
    const exe = path.join(UPD_DIR, info.fileName);
    if (v && fs.existsSync(exe) && vnum(v) > vnum(cur)) { r.ready = true; r.installer = exe; r.sha512 = info.sha512; if (vnum(v) > vnum(r.latest)) r.latest = v; }
  } catch {}
  r.available = vnum(r.latest) > vnum(cur);
  return r;
}
function sha512b64(file) {
  return new Promise((res, rej) => { const h = require('crypto').createHash('sha512'); const s = fs.createReadStream(file); s.on('data', d => h.update(d)); s.on('end', () => res(h.digest('base64'))); s.on('error', rej); });
}

// ---------- 工作区（与 Claw 原版共用 workspace-folder.json；workspace-context 插件每次对话前读取它） ----------
const WSF = path.join(STATE, 'workspace-folder.json');
function readWs() { try { return JSON.parse(fs.readFileSync(WSF, 'utf8')); } catch { return { path: null, current: null, recentFolders: [] }; } }
function writeWs(p) {
  const raw = fs.existsSync(WSF) ? fs.readFileSync(WSF, 'utf8') : null;
  if (raw && !fs.existsSync(WSF + '.bak.studio')) fs.writeFileSync(WSF + '.bak.studio', raw);   // 第一次改之前备份
  const d = raw ? JSON.parse(raw) : {};
  d.path = p; d.current = p;
  if (p) {
    const rec = (d.recentFolders || []).filter(r => r.path.toLowerCase() !== p.toLowerCase());
    rec.unshift({ path: p, lastUsed: Date.now() }); d.recentFolders = rec.slice(0, 10);
  }
  d.updatedAt = Date.now();
  const tmp = WSF + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8'); fs.renameSync(tmp, WSF);
  return d;
}
function pickFolder(initial) {
  // Windows 原生文件夹选择窗口（置顶显示）
  const ps = `Add-Type -AssemblyName System.Windows.Forms;$f=New-Object System.Windows.Forms.Form;$f.TopMost=$true;$f.ShowInTaskbar=$false;$f.WindowState='Minimized';$f.Show();$f.Hide();$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='选择 Claw 的工作区文件夹';$d.ShowNewFolderButton=$true;${initial ? "$d.SelectedPath='" + initial.replace(/'/g, "''") + "';" : ''}if($d.ShowDialog($f) -eq 'OK'){[Console]::OutputEncoding=[Text.Encoding]::UTF8;Write-Output $d.SelectedPath}`;
  return new Promise(resolve => {
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8', timeout: 600000, windowsHide: false }, (err, out) => resolve((out || '').trim() || null));
  });
}

// ---------- 每日 token 用量 ----------
const usageCache = {};   // file -> { mtime, days: { 'YYYY-MM-DD': {in,out,cache,calls,models:{}} } }
const dayKey = ts => { const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
function scanUsage(file) {
  let st; try { st = fs.statSync(file); } catch { return {}; }
  const c = usageCache[file]; if (c && c.mtime === st.mtimeMs) return c.days;
  const days = {};
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.includes('"usage"')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    const m = e.message; if (!m || m.role !== 'assistant' || !m.usage) continue;
    const u = m.usage, k = dayKey(e.timestamp || m.timestamp);
    const d = days[k] || (days[k] = { input: 0, output: 0, cache: 0, calls: 0, models: {} });
    d.input += u.input || 0; d.output += u.output || 0; d.cache += (u.cacheRead || 0) + (u.cacheWrite || 0); d.calls++;
    const mk = m.model || '?'; d.models[mk] = (d.models[mk] || 0) + (u.input || 0) + (u.output || 0);
  }
  usageCache[file] = { mtime: st.mtimeMs, days }; return days;
}
function getUsage(nDays) {
  const files = fs.readdirSync(SDIR).filter(f => /\.jsonl(\.deleted.*)?$/.test(f)).map(f => path.join(SDIR, f));
  const tot = {};
  for (const f of files) for (const [k, d] of Object.entries(scanUsage(f))) {
    const t = tot[k] || (tot[k] = { input: 0, output: 0, cache: 0, calls: 0, models: {} });
    t.input += d.input; t.output += d.output; t.cache += d.cache; t.calls += d.calls;
    for (const [m, n] of Object.entries(d.models)) t.models[m] = (t.models[m] || 0) + n;
  }
  const out = []; const now = new Date();
  for (let i = nDays - 1; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); const k = dayKey(d); out.push(Object.assign({ date: k }, tot[k] || { input: 0, output: 0, cache: 0, calls: 0, models: {} })); }
  return out;
}

// ---------- 模型列表（来自 openclaw.json 里配置的 provider） ----------
let modelCache = null;
async function getModels() {
  if (modelCache && Date.now() - modelCache.t < 300000) return modelCache.v;
  const c = await gw.call('config.get', {});
  const cfg = (c && (c.config || c.parsed)) || {};
  const provs = (cfg.models && cfg.models.providers) || {};
  const list = [];
  for (const [pid, p] of Object.entries(provs)) for (const m of p.models || []) list.push({ id: pid + '/' + m.id, name: m.name || m.id, vision: (m.input || []).includes('image'), ctx: m.contextWindow });
  const v = { models: list, default: cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model && cfg.agents.defaults.model.primary };
  modelCache = { t: Date.now(), v }; return v;
}

// ---------- 自检 ----------
const SELFTEST_FILE = path.join(C.DATA_DIR, 'selftest_last.json');
let selftestFn = null;
function getSelftest() { if (!selftestFn) selftestFn = require('./selftest')({ gw, STATE, SDIR, LOGDIR, getCredit, getClawVersion: () => { clawVersion = null; return getClawVersion(); }, getClawUpdate, CLAW_EXE }); return selftestFn; }
async function runSelftest(deep) { const r = await getSelftest()(deep); fs.writeFileSync(SELFTEST_FILE, JSON.stringify(r, null, 2)); return r; }
// 启动 20 秒后：如果 Claw / OpenClaw 版本和上次自检时不同，自动跑一次（只读，不花 token）
setTimeout(async () => {
  try { let last = {}; try { last = JSON.parse(fs.readFileSync(SELFTEST_FILE, 'utf8')); } catch {}
    const h = await gw.connect(); clawVersion = null;
    const cur = { claw: getClawVersion(), openclaw: h.server && h.server.version };
    if (cur.claw !== last.claw || cur.openclaw !== last.openclaw) { const r = await runSelftest(false); r.versionChangedFrom = { claw: last.claw, openclaw: last.openclaw }; fs.writeFileSync(SELFTEST_FILE, JSON.stringify(r, null, 2)); console.log('selftest after version change', JSON.stringify(r.summary)); }
  } catch (e) { console.log('auto selftest skipped:', e.message); }
}, 20000);


// ===================== v1.1.0：子任务 / 记忆 / 日志 =====================
const STUDIO_DATA = path.join(process.env.LOCALAPPDATA || '', 'ClawStudio');
const liveRuns = new Map();   // sessionKey -> { runId, startedAt, tool }
let liveHooked = false;
function hookLive() {
  if (liveHooked) return; liveHooked = true;
  gw.on(f => {
    const p = f.payload || {}; if (!p.sessionKey) return;
    if (f.event === 'agent' && p.stream === 'lifecycle' && p.data) {
      if (p.data.phase === 'start') liveRuns.set(p.sessionKey, { runId: p.runId, startedAt: p.data.startedAt || Date.now(), tool: '' });
      if (p.data.phase === 'end' || p.data.phase === 'error') liveRuns.delete(p.sessionKey);
    }
    if (f.event === 'agent' && p.stream === 'tool' && p.data && liveRuns.has(p.sessionKey)) liveRuns.get(p.sessionKey).tool = p.data.name || '';
    if (f.event === 'chat' && (p.state === 'final' || p.state === 'aborted' || p.state === 'error')) liveRuns.delete(p.sessionKey);
  });
}
function tailMessages(file) {
  // 读最后 ~400KB，取第一条用户消息（任务）和最后一条助手回复（结果）
  let first = '', last = '', lastRole = '', stop = '', err = '';
  try {
    const st = fs.statSync(file), fd = fs.openSync(file, 'r');
    const headLen = Math.min(st.size, 200000), head = Buffer.alloc(headLen); fs.readSync(fd, head, 0, headLen, 0);
    const tailLen = Math.min(st.size, 400000), tail = Buffer.alloc(tailLen); fs.readSync(fd, tail, 0, tailLen, st.size - tailLen); fs.closeSync(fd);
    for (const l of head.toString('utf8').split('\n')) { if (!l.includes('"role":"user"')) continue; try { const e = JSON.parse(l); const c = e.message.content; first = (Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : String(c || '')); break; } catch {} }
    for (const l of tail.toString('utf8').split('\n')) { if (!l.includes('"type":"message"')) continue; try { const e = JSON.parse(l); const m = e.message; if (!m) continue; lastRole = m.role;
      if (m.role === 'assistant') { const t = (Array.isArray(m.content) ? m.content.filter(x => x.type === 'text').map(x => x.text).join(' ') : String(m.content || '')); if (t) last = t; stop = m.stopReason || ''; err = m.errorMessage || ''; } } catch {} }
  } catch {}
  return { first, last, lastRole, stop, err };
}
function listSubagents(parent) {
  hookLive(); gw.connect().catch(() => {});
  const idx = loadIndex(), out = [];
  for (const [key, v] of Object.entries(idx)) {
    if (!key.includes(':subagent:')) continue;
    if (parent && v.spawnedBy !== parent) continue;
    const file = v.sessionFile || path.join(SDIR, v.sessionId + '.jsonl');
    const t = tailMessages(file), live = liveRuns.get(key);
    let status = live ? 'running' : v.abortedLastRun ? 'aborted' : t.err || t.stop === 'error' ? 'error' : t.lastRole === 'assistant' && t.last ? 'done' : (Date.now() - (v.updatedAt || 0) < 120000 ? 'running' : 'unknown');
    out.push({ key, label: v.label || '', parent: v.spawnedBy || '', role: v.subagentRole || '', depth: v.spawnDepth || 1,
      updatedAt: v.updatedAt || 0, tokens: v.totalTokens || 0, model: v.model || '', status, tool: live ? live.tool : '', startedAt: live ? live.startedAt : null,
      task: (t.first.split('[Subagent Task]:').pop() || '').replace(/\s+/g, ' ').trim().slice(0, 300), result: t.last.replace(/\s+/g, ' ').slice(0, 400), error: t.err });
  }
  return out.sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.updatedAt - a.updatedAt);
}

// ---- 后台任务：扫描近 N 小时对话里的后台 exec（"Command still running (session X, pid N)"），用 PID 判断是否仍在运行 ----
const bgCache = {};
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function scanBg(file, key) {
  let st; try { st = fs.statSync(file); } catch { return []; }
  const c = bgCache[file]; if (c && c.mtime === st.mtimeMs) return c.items;
  const items = [], byId = {}, bySess = {};
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.includes('toolCall') && !l.includes('toolResult')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; } const m = e.message; if (!m) continue;
    if (m.role === 'assistant' && Array.isArray(m.content)) for (const x of m.content) if (x.type === 'toolCall') byId[x.id] = { name: x.name, args: x.arguments || {}, ts: e.timestamp };
    if (m.role === 'toolResult') {
      const call = byId[m.toolCallId]; const txt = Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : String(m.content || '');
      if (call && call.name === 'exec') { const r = txt.match(/Command still running \(session ([\w-]+), pid (\d+)\)/);
        if (r) { const it = { key, session: r[1], pid: +r[2], command: String(call.args.command || '').slice(0, 400), startedAt: Date.parse(call.ts) || 0, exited: null }; items.push(it); bySess[r[1]] = it; } }
      if (call && call.name === 'process') { const sid = call.args.sessionId; const it = bySess[sid]; const x = txt.match(/(?:Process exited with code|exited with code) (-?\d+)/); if (it && x) it.exited = +x[1]; if (it && call.args.action === 'kill') it.exited = it.exited ?? 'killed'; }
    }
  }
  bgCache[file] = { mtime: st.mtimeMs, items }; return items;
}
function listBg(hours) {
  const idx = loadIndex(), since = Date.now() - hours * 3600e3, out = [];
  for (const [key, v] of Object.entries(idx)) { if ((v.updatedAt || 0) < since) continue;
    for (const it of scanBg(v.sessionFile || path.join(SDIR, v.sessionId + '.jsonl'), key)) if (it.startedAt >= since) out.push(Object.assign({}, it, { running: it.exited == null && pidAlive(it.pid) })); }
  return out.sort((a, b) => b.running - a.running || b.startedAt - a.startedAt);
}

// ---- 执行审批：订阅网关 exec.approval.* 事件 ----
const approvals = new Map();
let apprHooked = false;
function hookApprovals() {
  if (apprHooked) return; apprHooked = true;
  gw.on(f => {
    if (f.event === 'exec.approval.requested' && f.payload && f.payload.id) approvals.set(f.payload.id, f.payload);
    if (f.event === 'exec.approval.resolved' && f.payload) approvals.delete(f.payload.id);
  });
}
const listApprovals = () => { const now = Date.now(); for (const [k, a] of approvals) if (a.expiresAtMs && a.expiresAtMs < now - 5000) approvals.delete(k); return [...approvals.values()]; };

// ---- 记忆文件：只允许 workspace 下的 .md ----
function memFiles() {
  const out = [], W = WORKSPACE;
  const add = (group, rel) => { const p = path.join(W, rel); try { const st = fs.statSync(p); if (st.isFile()) out.push({ group, rel: rel.split(path.sep).join('/'), size: st.size, updatedAt: st.mtimeMs }); } catch {} };
  for (const f of ['MEMORY.md', 'USER.md', 'SOUL.md', 'IDENTITY.md', 'TOOLS.md', 'HEARTBEAT.md', 'AGENTS.md']) add(f === 'MEMORY.md' || f === 'USER.md' ? '长期记忆' : '核心设定', f);
  try { for (const f of fs.readdirSync(path.join(W, 'memory')).filter(f => f.endsWith('.md')).sort().reverse()) add('每日笔记', path.join('memory', f)); } catch {}
  try { (function walk(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = path.join(rel, e.name); if (e.isDirectory()) { if (e.name !== 'handoffs') walk(path.join(d, e.name), r); } else if (e.name.endsWith('.md')) add('任务档案', r); } })(path.join(W, 'tasks'), 'tasks'); } catch {}
  return out;
}
function memPath(rel) {
  const p = path.resolve(WORKSPACE, String(rel || ''));
  if (!p.toLowerCase().startsWith(path.resolve(WORKSPACE).toLowerCase() + path.sep) || !p.toLowerCase().endsWith('.md')) throw new Error('只允许编辑工作区内的 .md 文件');
  return p;
}

// ---- 日志 ----
const LOG_SECRETS = (() => { const s = []; try { const t = fs.readFileSync(path.join(STATE, 'openclaw.json'), 'utf8');
  for (const m of t.matchAll(/(?:apiKey|token)["']?\s*:\s*["']([^"']{16,})["']/g)) s.push(m[1]); } catch {} return s; })();
const redactLog = s => { for (const k of LOG_SECRETS) s = s.split(k).join('[REDACTED]');
  return s.replace(/gsk-[A-Za-z0-9_\-]{30,}|github_pat_[A-Za-z0-9_]{30,}|ghp_[A-Za-z0-9]{30,}|(?<![A-Za-z])sk-(proj-)?[A-Za-z0-9_\-]{32,}/g, '[REDACTED]'); };
function parseGwLine(l) {
  try { const j = JSON.parse(l); const m = j._meta || {};
    const parts = Object.keys(j).filter(k => /^\d+$/.test(k)).sort((a, b) => a - b).map(k => typeof j[k] === 'string' ? j[k] : JSON.stringify(j[k]));
    let src = m.name || ''; let msg = parts.join(' ');
    try { const p0 = JSON.parse(parts[0]); if (p0 && p0.subsystem) { src = p0.subsystem; msg = parts.slice(1).join(' '); } else if (p0 && p0.module) { src = p0.module; msg = parts.slice(1).join(' '); } } catch {}
    let lvl = (m.logLevelName || 'INFO').toUpperCase();
    const pm = msg.match(/^\s*\[(warn|warning|error|err|fatal|debug)\]\s*/i);   // 消息内自带的级别前缀
    if (pm) { const x = pm[1].toLowerCase(); lvl = x.startsWith('warn') ? 'WARN' : x.startsWith('err') ? 'ERROR' : x.toUpperCase(); }
    msg = msg.replace(/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\]\s*/, '');   // 去掉重复的 UTC 时间戳
    return { t: j.time || m.date || '', lvl, src, msg: redactLog(msg) };
  } catch { return { t: '', lvl: 'INFO', src: '', msg: redactLog(l) }; }
}
function tailFile(p, n) { try { const st = fs.statSync(p), len = Math.min(st.size, 300000), b = Buffer.alloc(len), fd = fs.openSync(p, 'r'); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
  return b.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-n).map(l => { const m = l.match(/^\[?(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d)\]?\s*(.*)$/); const msg = m ? m[2] : l; return { t: m ? m[1] : '', lvl: /error|fail|exception/i.test(msg) ? 'ERROR' : /warn/i.test(msg) ? 'WARN' : 'INFO', src: '', msg: redactLog(msg) }; }); } catch { return []; } }

// ---------- HTTP ----------
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) { return new Promise((r, j) => { const ch = []; req.on('data', d => ch.push(d)); req.on('end', () => r(Buffer.concat(ch).toString('utf8'))); req.on('error', j); }); }
const safeName = n => String(n || 'file').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(-120);

const routes = {
  'GET /': (u, res) => send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html; charset=utf-8'),
  'GET /api/sessions': (u, res) => send(res, 200, listSessions()),
  'GET /api/transcript': (u, res) => {
    const v = loadIndex()[u.searchParams.get('key')];
    send(res, 200, v ? readTranscript(v.sessionFile || path.join(SDIR, v.sessionId + '.jsonl')) : []);
  },
  // 任意本地文件：inline 预览或下载（只监听 127.0.0.1，本机使用）
  'GET /api/raw': (u, res) => {
    const p = u.searchParams.get('path') || '', dl = u.searchParams.get('dl') === '1';
    let st; try { st = fs.statSync(p); } catch { return send(res, 404, { error: '文件不存在或已被移动：' + p }); }
    if (!st.isFile()) return send(res, 400, { error: '不是文件' });
    const ext = (p.split('.').pop() || '').toLowerCase();
    const TYPES = { pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8', ipynb: 'application/json; charset=utf-8', py: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8', html: 'text/plain; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' };
    const name = p.split('\\').pop();
    res.writeHead(200, { 'Content-Type': dl ? 'application/octet-stream' : (TYPES[ext] || 'application/octet-stream'), 'Content-Length': st.size,
      'Content-Disposition': (dl ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(name), 'Cache-Control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  },
  'POST /api/open': async (u, res, req) => {
    const { path: p, reveal } = JSON.parse(await readBody(req));
    if (!p || !fs.existsSync(p)) return send(res, 404, { error: '文件不存在或已被移动' });
    const cp = require('child_process');
    if (reveal) cp.spawn('explorer.exe', ['/select,', p], { detached: true, stdio: 'ignore' }).unref();
    else cp.spawn('cmd.exe', ['/c', 'start', '""', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    send(res, 200, { ok: true });
  },
  'GET /api/file': (u, res) => {
    const p = u.searchParams.get('path') || '';
    if (!IMG_EXT.test(p)) return send(res, 403, { error: '只允许图片' });
    try { const b = fs.readFileSync(p); res.writeHead(200, { 'Content-Type': MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' }); res.end(b); }
    catch { send(res, 404, { error: 'not found' }); }
  },
  'GET /api/info': async (u, res) => {
    let oc = null; try { const h = await gw.connect(); oc = h.server && h.server.version; } catch {}
    let upd = null; try { upd = JSON.parse(fs.readFileSync(path.join(STATE, 'update-check.json'), 'utf8')); } catch {}
    send(res, 200, { claw: getClawVersion(), openclaw: oc, update: upd, clawUpdate: getClawUpdate(), credit: getCredit() });
  },
  'GET /api/models': async (u, res) => send(res, 200, await getModels()),
  'GET /api/skills': async (u, res) => {
    const s = await gw.call('skills.status', {});
    send(res, 200, (s.skills || []).filter(k => k.eligible && !k.disabled).map(k => ({ name: k.name, description: k.description })));
  },
  'GET /api/cron': async (u, res) => send(res, 200, await gw.call('cron.list', { includeDisabled: true })),
  'GET /api/events': (u, res, req) => {
    const key = u.searchParams.get('key');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    hookApprovals(); gw.connect().catch(e => res.write('event: gwerror\ndata: ' + JSON.stringify(e.message) + '\n\n'));
    const off = gw.on(f => {
      const pl = f.payload || {};
      if (f.event === 'exec.approval.requested' || f.event === 'exec.approval.resolved') { res.write('data: ' + JSON.stringify({ event: f.event, payload: pl }) + '\n\n'); return; }
      if ((f.event === 'chat' || f.event === 'agent') && (!key || pl.sessionKey === key))
        res.write('data: ' + JSON.stringify({ event: f.event, payload: pl }) + '\n\n');
    });
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { off(); clearInterval(ka); });
  },
  'POST /api/meta': async (u, res, req) => {
    const { key, name, pinned } = JSON.parse(await readBody(req));
    const meta = loadMeta(); meta[key] = meta[key] || {};
    if (name !== undefined) meta[key].name = String(name).slice(0, 200);
    if (pinned !== undefined) meta[key].pinned = !!pinned;
    saveMeta(meta); send(res, 200, { ok: true });
  },
  'POST /api/model': async (u, res, req) => {
    const { key, model } = JSON.parse(await readBody(req));
    const r = await gw.call('sessions.patch', { key, model: model || null });
    send(res, 200, { ok: true, model: r.entry && r.entry.model });
  },
  'POST /api/send': async (u, res, req) => {
    let { key, message, files, model } = JSON.parse(await readBody(req));
    files = Array.isArray(files) ? files.slice(0, 20) : [];
    if ((!message || !message.trim()) && !files.length) return send(res, 400, { error: '消息为空' });
    if (!key) key = 'agent:main:chat-' + Date.now();
    if (model) { try { await gw.call('sessions.patch', { key, model }); } catch {} }
    // 所有附件都存到 workspace\uploads，路径附在消息末尾（与 Claw 原界面一致）；图片额外作为多模态附件发送
    fs.mkdirSync(UPLOADS, { recursive: true });
    const saved = [], attachments = [];
    for (const f of files) {
      const buf = Buffer.from(f.b64, 'base64');
      const p = path.join(UPLOADS, Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + safeName(f.name));
      fs.writeFileSync(p, buf); saved.push(p);
      if (/^image\//.test(f.mime || '') && buf.length <= 5e6) attachments.push({ type: 'image', mimeType: f.mime, fileName: f.name, content: f.b64 });
    }
    let text = (message || '').trim();
    if (saved.length) text += (text ? '\n\n' : '') + '[Attached files]\n' + saved.join('\n');
    const p = { sessionKey: key, message: text, idempotencyKey: 'sm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) };
    if (attachments.length) p.attachments = attachments;
    const r = await gw.call('chat.send', p, 120000);
    send(res, 200, { ok: true, key, runId: r.runId, saved });
  },
  'POST /api/claw-update': async (u, res) => {
    const up = getClawUpdate();
    if (!up.available) return send(res, 400, { error: '当前已是最新版本' });
    if (!up.ready) return send(res, 409, { error: '新版本安装包还在后台下载中，请稍后再试（Claw 会自动下载）' });
    // 校验安装包完整性（与 Claw 自带更新器同样的 sha512）
    const got = await sha512b64(up.installer);
    if (up.sha512 && got !== up.sha512) return send(res, 500, { error: '安装包校验失败（sha512 不匹配），已取消。请在 Claw 里重新检查更新。' });
    send(res, 200, { ok: true, version: up.latest });
    // 与 Claw 内置更新相同的参数：安装后自动重新启动 Claw
    setTimeout(() => {
      require('child_process').spawn(up.installer, ['--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    }, 500);
  },
  'GET /api/workspace': (u, res) => {
    const d = readWs();
    send(res, 200, { path: d.path, exists: d.path ? fs.existsSync(d.path) : null, recent: (d.recentFolders || []).map(r => ({ path: r.path, lastUsed: r.lastUsed, exists: fs.existsSync(r.path) })) });
  },
  'POST /api/workspace': async (u, res, req) => {
    let { path: p, pick } = JSON.parse(await readBody(req) || '{}');
    if (pick) { p = await pickFolder(readWs().path); if (!p) return send(res, 200, { cancelled: true }); }
    if (p) { p = path.resolve(p); if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return send(res, 400, { error: '文件夹不存在：' + p }); }
    const d = writeWs(p || null);
    send(res, 200, { ok: true, path: d.path });
  },
  'GET /api/ctxcost': (u, res) => send(res, 200, ctxCost(u.searchParams.get('key')) || { report: null }),
  'GET /api/usage': (u, res) => send(res, 200, getUsage(Math.min(90, +u.searchParams.get('days') || 30))),
  'GET /api/selftest': async (u, res) => {
    if (u.searchParams.get('last')) { try { return send(res, 200, JSON.parse(fs.readFileSync(SELFTEST_FILE, 'utf8'))); } catch { return send(res, 200, null); } }
    send(res, 200, await runSelftest(u.searchParams.get('deep') === '1'));
  },
  'POST /api/openurl': async (u, res, req) => {
    const { url } = JSON.parse(await readBody(req));
    if (!/^https?:\/\//i.test(url || '')) return send(res, 400, { error: '只能打开 http/https 链接' });
    require('child_process').spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
    send(res, 200, { ok: true });
  },
  // 全文搜索：所有会话的所有用户/Claw 消息（不区分大小写），返回每个会话的命中数和前几条片段
  'GET /api/search': (u, res) => {
    const q = (u.searchParams.get('q') || '').trim().toLowerCase();
    if (q.length < 2) return send(res, 200, []);
    const idx = loadIndex(), out = [];
    for (const [key, v] of Object.entries(idx)) {
      const file = v.sessionFile || path.join(SDIR, v.sessionId + '.jsonl');
      let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (!txt.toLowerCase().includes(q)) continue;
      let hits = 0; const snips = [];
      for (const m of readTranscript(file)) {
        const low = m.text.toLowerCase(); let i = low.indexOf(q);
        while (i >= 0) { hits++; if (snips.length < 3) snips.push({ role: m.role, ts: m.ts, text: m.text.slice(Math.max(0, i - 40), i + q.length + 60) }); i = low.indexOf(q, i + q.length); }
      }
      if (hits) out.push({ key, hits, snips });
    }
    out.sort((a, b) => b.hits - a.hits);
    send(res, 200, out);
  },
  'GET /api/bg': (u, res) => { hookLive(); const runs = [...liveRuns.entries()].map(([key, r]) => ({ key, startedAt: r.startedAt, tool: r.tool })); send(res, 200, { runs, procs: listBg(Math.min(168, +u.searchParams.get('hours') || 24)) }); },
  'POST /api/bg/kill': async (u, res, req) => {
    const { pid, key, session } = JSON.parse(await readBody(req));
    const it = listBg(168).find(x => x.pid === +pid && x.key === key && x.session === session);
    if (!it) return send(res, 404, { error: '没有找到这个后台任务（只能结束 Claw 启动的后台命令）' });
    if (!it.running) return send(res, 400, { error: '它已经结束了' });
    require('child_process').execFile('taskkill.exe', ['/PID', String(it.pid), '/T', '/F'], { windowsHide: true }, (err, out, er) => send(res, err ? 500 : 200, err ? { error: (er || err.message).toString().trim() } : { ok: true }));
  },
  'GET /api/approvals': (u, res) => { hookApprovals(); gw.connect().catch(() => {}); send(res, 200, listApprovals()); },
  'POST /api/approvals/resolve': async (u, res, req) => {
    const { id, decision } = JSON.parse(await readBody(req));
    if (!['allow-once', 'allow-always', 'deny'].includes(decision)) return send(res, 400, { error: '无效的决定' });
    await gw.call('exec.approval.resolve', { id, decision }); approvals.delete(id); send(res, 200, { ok: true });
  },
  'GET /api/subagents': (u, res) => send(res, 200, listSubagents(u.searchParams.get('parent') || '')),
  'POST /api/subagents/abort': async (u, res, req) => {
    const { key } = JSON.parse(await readBody(req));
    if (!String(key || '').includes(':subagent:')) return send(res, 400, { error: '只能停止子任务' });
    await gw.call('chat.abort', { sessionKey: key }); liveRuns.delete(key); send(res, 200, { ok: true });
  },
  'GET /api/memory/list': (u, res) => send(res, 200, { workspace: WORKSPACE, files: memFiles() }),
  'GET /api/memory/file': (u, res) => { const p = memPath(u.searchParams.get('rel')); const st = fs.statSync(p); send(res, 200, { rel: u.searchParams.get('rel'), content: fs.readFileSync(p, 'utf8'), updatedAt: st.mtimeMs, path: p }); },
  'POST /api/memory/file': async (u, res, req) => {
    const { rel, content, baseUpdatedAt } = JSON.parse(await readBody(req));
    const p = memPath(rel); const st = fs.statSync(p);
    if (baseUpdatedAt && Math.abs(st.mtimeMs - baseUpdatedAt) > 1) return send(res, 409, { error: '这个文件在你打开之后被修改过（可能是 Claw 刚写入），请重新加载后再改' });
    const bdir = path.join(STUDIO_DATA, 'memory-backups'); fs.mkdirSync(bdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(p, path.join(bdir, String(rel).replace(/[\\/]/g, '__') + '.' + stamp + '.bak'));
    fs.writeFileSync(p, content, 'utf8');
    send(res, 200, { ok: true, updatedAt: fs.statSync(p).mtimeMs });
  },
  'GET /api/memory/search': (u, res) => {
    const q = (u.searchParams.get('q') || '').trim().toLowerCase(); if (q.length < 2) return send(res, 200, []);
    const out = [];
    for (const f of memFiles()) { let lines; try { lines = fs.readFileSync(path.join(WORKSPACE, f.rel), 'utf8').split(/\r?\n/); } catch { continue; }
      const hits = []; lines.forEach((l, i) => { if (l.toLowerCase().includes(q) && hits.length < 5) hits.push({ line: i + 1, text: l.trim().slice(0, 200) }); });
      if (hits.length) out.push({ rel: f.rel, group: f.group, hits }); }
    send(res, 200, out);
  },
  'GET /api/logs': async (u, res) => {
    const src = u.searchParams.get('src') || 'gateway';
    if (src === 'gateway') {
      const p = { limit: 400, maxBytes: 400000 }; const c = u.searchParams.get('cursor'); if (c) p.cursor = +c;
      const r = await gw.call('logs.tail', p, 20000);
      return send(res, 200, { src, file: r.file, cursor: r.cursor, lines: (r.lines || []).map(parseGwLine) });
    }
    const f = { launch: 'launch.log', server: 'server.err.log', serverout: 'server.out.log' }[src];
    if (!f) return send(res, 400, { error: 'unknown source' });
    send(res, 200, { src, file: path.join(STUDIO_DATA, f), cursor: null, lines: tailFile(path.join(STUDIO_DATA, f), 500) });
  },
  'GET /api/cron/runs': async (u, res) => {
    const r = await gw.call('cron.runs', { id: u.searchParams.get('id'), limit: 20 });
    send(res, 200, (r.entries || []).map(e => ({ ts: e.ts, runAtMs: e.runAtMs, status: e.status, error: e.error || '', summary: e.summary || '', durationMs: e.durationMs, model: e.model || '', sessionKey: e.sessionKey || '' })));
  },
  'POST /api/abort': async (u, res, req) => {
    const { key, runId } = JSON.parse(await readBody(req));
    await gw.call('chat.abort', runId ? { sessionKey: key, runId } : { sessionKey: key });
    send(res, 200, { ok: true });
  },
  'POST /api/cron': async (u, res, req) => {
    const { action, id, job, patch } = JSON.parse(await readBody(req));
    let r;
    if (action === 'add') r = await gw.call('cron.add', job);
    else if (action === 'update') r = await gw.call('cron.update', { id, patch });
    else if (action === 'remove') r = await gw.call('cron.remove', { id });
    else if (action === 'run') r = await gw.call('cron.run', { id, mode: 'force' });
    else return send(res, 400, { error: 'bad action' });
    send(res, 200, { ok: true, result: r });
  }
};

applyClawEnv(CLAW_EXE);
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  // 静态资源：图标 / manifest
  if (req.method === 'GET' && /^\/app\/(icon_192\.png|icon_1024\.png|icon\.ico|manifest\.json)$/.test(u.pathname)) {
    const fp = path.join(__dirname, u.pathname);
    const ct = { png: 'image/png', ico: 'image/x-icon', json: 'application/manifest+json' }[u.pathname.split('.').pop()];
    try { res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'max-age=86400' }); return res.end(fs.readFileSync(fp)); } catch { return send(res, 404, { error: 'not found' }); }
  }
  if (req.method === 'GET' && u.pathname === '/favicon.ico') { try { res.writeHead(200, { 'Content-Type': 'image/x-icon' }); return res.end(fs.readFileSync(path.join(__dirname, 'app', 'icon.ico'))); } catch {} }
  const h = routes[(req.method === 'HEAD' ? 'GET' : req.method) + ' ' + u.pathname];
  if (!h) return send(res, 404, { error: 'not found' });
  try { await h(u, res, req); }
  catch (e) { if (!res.headersSent) send(res, 502, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => console.log('Claw 会话管理器: http://127.0.0.1:' + PORT));
