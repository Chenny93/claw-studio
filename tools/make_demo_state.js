// 生成一个演示用的假数据目录（用于 README 截图，不含任何真实聊天）
// 用法：node tools/make_demo_state.js <outDir>   然后 CLAW_STATE_DIR=<outDir> 启动 server.js
const fs = require('fs'), path = require('path');
const OUT = process.argv[2]; if (!OUT) throw new Error('usage: node make_demo_state.js <outDir>');
const real = process.argv[3]; // 可选：真实 state 目录，用于复制 openclaw.json（网关 token / 模型列表）
const S = path.join(OUT, 'agents', 'main', 'sessions'); fs.mkdirSync(S, { recursive: true });
if (real) { fs.copyFileSync(path.join(real, 'openclaw.json'), path.join(OUT, 'openclaw.json')); try { fs.copyFileSync(path.join(real, 'genclaw.json'), path.join(OUT, 'genclaw.json')); } catch {} }
fs.writeFileSync(path.join(OUT, 'workspace-folder.json'), JSON.stringify({ path: null, recentFolders: [{ path: 'D:\\Projects\\thesis', lastUsed: Date.now() - 864e5 }, { path: 'D:\\Projects\\website', lastUsed: Date.now() - 3 * 864e5 }] }));
const day = 864e5, now = Date.now();
const convs = [
  ['帮我把这份实验数据画成折线图，横轴是温度，纵轴是反应速率', '好的！我用 matplotlib 画了折线图，并标注了最大值点：\n\n```python\nimport matplotlib.pyplot as plt\nplt.plot(temp, rate, marker="o")\nplt.xlabel("Temperature (°C)")\nplt.ylabel("Rate")\nplt.show()\n```\n\n**结论**：反应速率在 **45°C** 左右达到峰值，之后下降，说明酶开始失活。', 0],
  ['用简单的例子讲讲 PCA 和 SVD 的关系', '### 一句话\nPCA 就是对**中心化后的数据矩阵**做 SVD。\n\n### 例子\n1. 把数据 X 每列减去均值\n2. 做 SVD：X = U Σ Vᵀ\n3. V 的列就是主成分方向，Σ² / (n−1) 就是各主成分的方差\n\n| 概念 | PCA | SVD |\n|---|---|---|\n| 输入 | 协方差矩阵 | 数据矩阵本身 |\n| 输出 | 特征向量 | 右奇异向量 V |', 0.2],
  ['每天早上 9 点给我一份 AI 新闻摘要', '已创建定时任务 **「每日 AI 新闻」**：每天 09:00 自动搜索并整理 5 条最重要的 AI 新闻，结果会发到这个会话。', 1],
  ['把这篇英文摘要翻译成中文，保持学术语气', '以下为译文：\n\n> 本研究提出了一种基于注意力机制的轻量级模型，在保持精度的同时将推理延迟降低了 37%……', 2],
  ['检查一下我网站首页的 SEO 问题', '我检查了首页，发现 3 个主要问题：\n\n1. 缺少 `meta description`\n2. 图片没有 `alt` 文本（12 张）\n3. 标题层级跳跃：H1 之后直接是 H3\n\n要我直接帮你修改吗？', 5],
  ['周末去黄山，帮我做一个两天的行程', '**第一天**：云谷寺索道上山 → 始信峰 → 北海 → 光明顶看日落\n\n**第二天**：光明顶日出 → 西海大峡谷 → 迎客松 → 玉屏索道下山', 9],
];
const idx = {};
convs.forEach(([q, a, d], i) => {
  const t0 = now - d * day - (i + 1) * 3600e3, sid = 'demo' + String(i).padStart(4, '0') + '-0000-4000-8000-000000000000', key = 'agent:main:chat-' + t0;
  const L = [{ type: 'session', version: 3, id: sid, timestamp: new Date(t0).toISOString() },
    { type: 'message', id: 'u' + i, timestamp: new Date(t0).toISOString(), message: { role: 'user', content: [{ type: 'text', text: q }] } },
    { type: 'message', id: 'a' + i, timestamp: new Date(t0 + 9000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: a }], usage: { input: 1200, output: 300, cacheRead: 30000 }, model: 'claude-opus-5-5' } }];
  fs.writeFileSync(path.join(S, sid + '.jsonl'), L.map(x => JSON.stringify(x)).join('\n') + '\n');
  idx[key] = { sessionId: sid, updatedAt: t0 + 9000, sessionFile: path.join(S, sid + '.jsonl'), totalTokens: 180000 + i * 40000, contextTokens: 1000000, model: 'claude-opus-5-5', modelProvider: 'genspark-llm-proxy', chatType: 'direct' };
});
fs.writeFileSync(path.join(S, 'sessions.json'), JSON.stringify(idx, null, 2));
console.log('demo state at', OUT, Object.keys(idx).length, 'sessions');
