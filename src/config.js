// Claw Studio — 自动探测本机 Genspark Claw 的安装与数据位置（无需手动配置）
// 可用环境变量覆盖：CLAW_STATE_DIR、CLAW_EXE、CLAW_STUDIO_PORT
const fs = require('fs'), path = require('path'), os = require('os');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const CLAW_ROOT = path.join(APPDATA, 'Genspark Claw');

function findStateDir() {
  if (process.env.CLAW_STATE_DIR) return process.env.CLAW_STATE_DIR;
  const users = path.join(CLAW_ROOT, 'users');
  let best = null, bestT = 0;
  try {
    for (const d of fs.readdirSync(users)) {
      const p = path.join(users, d), cfg = path.join(p, 'openclaw.json');
      if (!fs.existsSync(cfg)) continue;
      // 多账号时选最近使用的（sessions.json 最新修改）
      let t = fs.statSync(cfg).mtimeMs;
      try { t = Math.max(t, fs.statSync(path.join(p, 'agents', 'main', 'sessions', 'sessions.json')).mtimeMs); } catch {}
      if (t > bestT) { best = p; bestT = t; }
    }
  } catch {}
  return best;
}

const STATE = findStateDir();
if (!STATE) {
  console.error('[Claw Studio] 找不到 Genspark Claw 的用户数据目录（' + path.join(CLAW_ROOT, 'users') + '）。请先安装并登录 Genspark Claw，或设置环境变量 CLAW_STATE_DIR。');
  process.exit(1);
}

function readGenclaw() { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'genclaw.json'), 'utf8')); } catch { return {}; } }

function findClawExe() {
  if (process.env.CLAW_EXE && fs.existsSync(process.env.CLAW_EXE)) return process.env.CLAW_EXE;
  const g = readGenclaw();
  if (g.cli && g.cli.nodeBinary && fs.existsSync(g.cli.nodeBinary)) return g.cli.nodeBinary;
  for (const p of [path.join(LOCALAPPDATA, 'Programs', 'Genspark Claw', 'Genspark Claw.exe'), 'C:\\Program Files\\Genspark Claw\\Genspark Claw.exe'])
    if (fs.existsSync(p)) return p;
  return null;
}

const CLAW_EXE = findClawExe();
module.exports = {
  STATE,
  SDIR: path.join(STATE, 'agents', 'main', 'sessions'),
  WORKSPACE: (() => { try { const t = fs.readFileSync(path.join(STATE, 'openclaw.json'), 'utf8'); const m = t.match(/workspace["']?\s*:\s*["']([^"']+)["']/); if (m) return m[1].replace(/\\\\/g, '\\'); } catch {} return path.join(STATE, 'workspace'); })(),
  LOGDIR: path.join(CLAW_ROOT, 'logs'),
  CLAW_ROOT,
  CLAW_EXE,
  ASAR: CLAW_EXE ? path.join(path.dirname(CLAW_EXE), 'resources', 'app.asar') : null,
  UPD_DIR: path.join(LOCALAPPDATA, 'genclaw-updater', 'pending'),
  GW_PORT: () => readGenclaw().port || 28815,
  PORT: +(process.env.CLAW_STUDIO_PORT || 28900),
  DATA_DIR: path.join(LOCALAPPDATA, 'ClawStudio'),   // Studio 自己的数据（改名/置顶、自检结果、上传文件）
};
