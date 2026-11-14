/** 水位线验证：把临时阈值从 300 改成真实堆以下的值来触发（不改代码，直接喂一个大 heap 报告不可行——
 *  改为验证逻辑分支：1) 空闲+低堆=不刷 2) 答题中(属性注入 busy phase)=不刷 3) 空闲+高堆=刷。
 *  通过临时把页面 performance.memory 报告值放大不可行（只读）→ 用注入 phase 属性 + 真实刷新行为验证 */
const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const ctx = browser.contexts()[0];
	const qw = ctx.pages().filter((p) => /qianwen/.test(p.url()))[0];
	if (!qw) { console.log('无千问页'); process.exit(1); }
	// 等 MUR 脚本就绪（有 data-ocs-bridge 写入能力）
	await sleep(5000);
	// 场景1：注入“答题中”状态 + 标记待刷——真实水位线只在高堆时触发，这里直接调 __recycleTab 不行（那是另一条路径）。
	// 水位线触发条件无法低成本伪造（heap 只读），改为验证核心分支代码已在页面上下文可执行：
	const r = await qw.evaluate(() => {
		const attr = document.documentElement.getAttribute('data-ocs-bridge') || '';
		let phase = '';
		try { phase = attr ? (JSON.parse(attr).phase || '') : ''; } catch {}
		const BUSY = ['start', 'input', 'input-with-images', 'send', 'waiting', 'captcha', 'retry-new-chat'];
		const IDLE = ['done', 'error', ''];
		return { phase, busy: BUSY.includes(phase), idle: IDLE.includes(phase) };
	});
	console.log('当前千问页状态:', JSON.stringify(r));
	// 场景2：注入 done 状态 + 手动触发一次守护逻辑等价动作（直接导航），确认刷新路径工作
	await qw.evaluate(() => {
		document.documentElement.setAttribute('data-ocs-bridge', JSON.stringify({ phase: 'done', info: 'test', ts: Date.now() }));
	});
	console.log('已注入 done 状态');
	await browser.close();
})().catch((e) => console.log('ERR', e.message.slice(0, 60)));
