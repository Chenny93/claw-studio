// Claw Studio 自检：逐项检查 Studio 依赖的 Claw / OpenClaw 内部接口是否还正常
// 默认只读、不花 token；deep=true 时额外向测试会话发一条消息做端到端测试
const fs = require('fs'), path = require('path');
module.exports = (ctx) => async function selftest(deep) {
  const { gw, STATE, SDIR, LOGDIR, getCredit, getClawVersion, getClawUpdate, CLAW_EXE } = ctx;
  const R = [];
  const add = (group, name, ok, detail, fix) => R.push({ group, name, status: ok === true ? 'ok' : ok === 'warn' ? 'warn' : 'fail', detail: String(detail || ''), fix: fix || '' });
  const T = async (group, name, fn, fix) => { try { const r = await fn(); add(group, name, r[0], r[1], fix); } catch (e) { add(group, name, false, e.message, fix); } };

  // ---- 1. 本地数据文件 ----
  await T('数据', '用户数据目录', () => [fs.existsSync(STATE), STATE], 'Claw 升级后用户目录可能改名：更新 server.js / gw.js 里的 STATE');
  let idx = null;
  await T('数据', '会话索引 sessions.json', () => { idx = JSON.parse(fs.readFileSync(path.join(SDIR, 'sessions.json'), 'utf8')); const n = Object.keys(idx).length; return [n > 0, n + ' 个会话']; }, '会话存储位置或格式变了：改 server.js 的 SDIR / listSessions');
  await T('数据', '会话记录格式 (.jsonl)', () => {
    const v = Object.values(idx).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    const f = v.sessionFile || path.join(SDIR, v.sessionId + '.jsonl');
    let msg = 0, usage = 0, roles = new Set();
    for (const l of fs.readFileSync(f, 'utf8').split('\n').slice(-400)) { if (!l) continue; try { const e = JSON.parse(l); if (e.type === 'message' && e.message) { msg++; roles.add(e.message.role); if (e.message.usage) usage++; } } catch {} }
    return [msg > 0 && roles.has('user') ? (usage > 0 ? true : 'warn') : false, `最近会话：${msg} 条消息，角色 ${[...roles].join('/')}，${usage} 条带 usage` + (usage ? '' : '（每日用量统计会失效）')];
  }, '记录格式变了：改 server.js 的 parseEntry / scanUsage');
  await T('数据', '会话字段（上下文/模型）', () => {
    const v = Object.values(idx).find(x => x.totalTokens) || {};
    const miss = ['totalTokens', 'contextTokens', 'model', 'modelProvider', 'updatedAt'].filter(k => !(k in v));
    return [miss.length ? 'warn' : true, miss.length ? '缺少字段：' + miss.join(', ') : '字段齐全'];
  }, '上下文环 / 模型显示依赖这些字段');
  await T('数据', '工作区设置 workspace-folder.json', () => { const d = JSON.parse(fs.readFileSync(path.join(STATE, 'workspace-folder.json'), 'utf8')); return ['path' in d ? true : 'warn', 'path=' + d.path + '，最近 ' + (d.recentFolders || []).length + ' 个']; }, '工作区格式变了：改 server.js 的 readWs/writeWs');

  // ---- 2. 网关接口 ----
  let hello = null;
  await T('网关', '连接网关 (WebSocket)', async () => { hello = await gw.connect(); return [true, 'OpenClaw ' + (hello.server && hello.server.version) + '，协议 v' + hello.protocol]; }, 'Claw 没开，或网关协议/认证方式变了：检查 gw.js 的 connect 参数（协议版本、client id、token 位置）');
  const need = { 'chat.send': '发消息', 'chat.abort': '停止/修改', 'sessions.patch': '切换模型', 'skills.status': '/ 技能菜单', 'cron.list': '定时任务', 'cron.add': '新建定时任务', 'config.get': '模型列表' };
  if (hello) {
    const have = new Set((hello.features && hello.features.methods) || []);
    const lost = Object.keys(need).filter(m => !have.has(m));
    add('网关', '所需接口', lost.length ? false : true, lost.length ? '缺少：' + lost.map(m => m + '（' + need[m] + '）').join('、') : Object.keys(need).length + ' 个接口都在', '接口改名或移除：在 OpenClaw 文档里找替代方法，改 server.js 对应路由');
  }
  await T('网关', '模型列表', async () => { const c = await gw.call('config.get', {}); const cfg = c.config || c.parsed || {}; const n = Object.values((cfg.models && cfg.models.providers) || {}).reduce((a, p) => a + (p.models || []).length, 0); return [n > 0, n + ' 个模型']; }, '配置结构变了：改 server.js 的 getModels');
  await T('网关', '技能列表', async () => { const s = await gw.call('skills.status', {}); return [(s.skills || []).length > 0, (s.skills || []).length + ' 个技能']; });
  await T('网关', '定时任务', async () => { const s = await gw.call('cron.list', { includeDisabled: true }); return [Array.isArray(s.jobs), (s.jobs || []).length + ' 个任务']; });

  // ---- 3. Claw 桌面端信息 ----
  await T('Claw', 'Claw 版本号', () => { const v = getClawVersion(); return [v && v !== '未知' ? true : 'warn', v]; }, '安装位置或打包格式变了：server.js 现在从 genclaw.json 自动找安装目录');
  await T('Claw', '积分读取（日志）', () => {
    const c = getCredit(); if (c.error) return ['warn', c.error];
    const age = c.at ? (Date.now() - new Date(c.at.replace(' ', 'T')).getTime()) / 3600e3 : 999;
    return [age < 24 ? true : 'warn', c.balance + ' 积分，记录于 ' + c.at + (age >= 24 ? '（超过 24 小时，可能日志格式变了）' : '')];
  }, '依赖 app.log 里的 "Benefits fetched successfully" 行；格式变了就改 server.js 的 getCredit');
  await T('Claw', '更新检测（日志）', () => { const u = getClawUpdate(); return [u.checkedAt ? true : 'warn', u.checkedAt ? '最近检查 ' + u.checkedAt + (u.available ? '，有新版 ' + u.latest : '，已是最新') : '日志里找不到更新检查记录']; }, '依赖 app.log 里的 [Update] 行和 genclaw-updater 目录');
  await T('Claw', '启动器能找到 Claw 程序', () => [fs.existsSync(CLAW_EXE) ? true : 'warn', CLAW_EXE], 'Claw 装到别处了：launch.ps1 会自动搜索，必要时改第一行 $ClawExe');

  // ---- 3b. gsk（Genspark 工具 CLI：搜索/生图/视频/文档等）----
  await T('Claw', 'gsk 工具 CLI 连通性', async () => {
    const cp = require('child_process');
    const run = (env) => new Promise(res => cp.execFile(process.env.SystemRoot ? process.env.SystemRoot + '\\System32\\cmd.exe' : 'cmd.exe', ['/d', '/s', '/c', 'gsk list-tools'], { env: { ...process.env, ...env }, timeout: 45000, windowsHide: true }, (e, out, err) => res(String(out || '') + String(err || ''))));
    // 系统代理（IE/Windows 设置）
    let sysProxy = ''; try { const o = cp.execFileSync((process.env.SystemRoot || 'C:\\Windows') + '\\System32\\reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true });
      if (/ProxyEnable\s+REG_DWORD\s+0x1/.test(o)) { const m = o.match(/ProxyServer\s+REG_SZ\s+(\S+)/); if (m) sysProxy = m[1]; } } catch {}
    const out = await run({});
    if (/"tools"\s*:/.test(out)) return [true, '正常' + (process.env.HTTPS_PROXY ? '（经代理 ' + process.env.HTTPS_PROXY + '）' : '')];
    if (/not recognized|不是内部或外部命令|ENOENT/i.test(out)) return ['warn', '没有找到 gsk 命令（Claw 版本可能不自带）'];
    if (/403/.test(out) && sysProxy) {
      const p = 'http://' + sysProxy.replace(/^https?=|^http:\/\//, '').split(';')[0];
      const out2 = await run({ HTTPS_PROXY: p, HTTP_PROXY: p, NODE_USE_ENV_PROXY: '1' });
      if (/"tools"\s*:/.test(out2)) return [false, 'gsk 返回 403：它没有走系统代理 ' + sysProxy + '（加上代理后测试可以连通）'];
    }
    return [false, 'gsk 失败：' + out.replace(/\s+/g, ' ').slice(0, 160)];
  }, '在 Claw 配置 openclaw.json 里加 env.vars：HTTPS_PROXY / HTTP_PROXY = 你的系统代理地址，NODE_USE_ENV_PROXY = "1"，NO_PROXY = "localhost,127.0.0.1"，然后重启 Claw');
  await T('Claw', '日志目录', () => [fs.existsSync(LOGDIR), LOGDIR]);

  // ---- 4. 端到端（可选，花少量 token）----
  if (deep) {
    await T('端到端', '发消息并收到回复', async () => {
      const key = 'agent:main:studio-selftest';
      const got = new Promise((res, rej) => { const off = gw.on(f => { const p = f.payload || {};
        if (f.event === 'chat' && p.sessionKey === key && (p.state === 'final' || p.state === 'error')) { off(); const t = ((p.message && p.message.content) || []).filter(c => c.type === 'text').map(c => c.text).join(''); p.state === 'final' ? res(t) : rej(new Error(p.errorMessage || 'error')); } });
        setTimeout(() => { off(); rej(new Error('60 秒内没有回复')); }, 60000); });
      await gw.call('chat.send', { sessionKey: key, message: '自检：只回复两个字母 OK，不要调用工具', idempotencyKey: 'st-' + Date.now() });
      const t = await got; return [/ok/i.test(t), '回复：' + t.slice(0, 40)];
    }, '发消息链路坏了：检查 chat.send 参数和 chat 事件格式（gw.js / server.js /api/events）');
  }
  const sum = { ok: R.filter(r => r.status === 'ok').length, warn: R.filter(r => r.status === 'warn').length, fail: R.filter(r => r.status === 'fail').length };
  return { at: new Date().toISOString(), claw: getClawVersion(), openclaw: hello && hello.server && hello.server.version, summary: sum, results: R };
};
