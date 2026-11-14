// 推送最新脚本到浏览器（MUR 2.0）：唤醒 SW → 调 install() → 从本地 HTTP 服务拉新代码并重新注册
// 前提：serve 服务(18923) 在跑、浏览器 CDP 端口可达
const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');

(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:' + (process.env.CDP_PORT || 9222));
	const ctx = browser.contexts()[0];
	// 唤醒可能空闲的 MV3 SW：经任意页面的 relay 发一条消息
	const anyPage = ctx.pages().find((p) => p.url().startsWith('http'));
	if (anyPage && ctx.serviceWorkers().length === 0) {
		await anyPage.evaluate(() => window.postMessage({ __mur: 1, m: { t: 'sync' }, rid: 'wake' }, '*')).catch(() => {});
		await new Promise((r) => setTimeout(r, 2000));
	}
	let mur = ctx.serviceWorkers().find((w) => w.url().includes('.js'));
	if (!mur) { console.log('!! MUR SW 未找到'); process.exit(1); }
	console.log('SW:', mur.url().split('/').pop());

	// 调 SW 的 install()：重新 fetch 脚本 + 双注册
	const res = await mur.evaluate(async () => {
		await install();
		const scripts = await chrome.userScripts.getScripts();
		return scripts.map((s) => ({ id: s.id, world: s.world, codeLen: s.js[0].code.length }));
	});
	console.log('注册结果:', JSON.stringify(res, null, 1));
	const app = res.find((s) => s.id === 'mur-app');
	if (!app || app.codeLen < 500000) { console.log('!! mur-app 缺失或过小'); process.exit(1); }
	console.log('推送完成 ✓ (mur-app ' + (app.codeLen / 1024).toFixed(0) + 'KB)');
	await browser.close();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
