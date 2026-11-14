/** 连接测试浏览器（CDP 9222）执行命令：node connect.js <cmd> */
const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');

function log(...a) { console.log('[' + new Date().toLocaleTimeString() + ']', ...a); }

(async () => {
	const cmd = process.argv[2] || 'status';
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
	const ctx = browser.contexts()[0];
	log('已连接, 页面:', ctx.pages().map(p => p.url().substring(0, 60)).join(' | '));

	if (cmd === 'tm') {
		// 打开 TM 管理面板看已装脚本
		const p = await ctx.newPage();
		await p.goto('chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=dashboard');
		await new Promise(r => setTimeout(r, 3000));
		const info = await p.evaluate(() => {
			const rows = Array.from(document.querySelectorAll('tr, [class*="script"]'));
			return rows.slice(0, 30).map(r => (r.innerText || '').replace(/\n/g, ' | ').substring(0, 150)).filter(t => t.length > 5);
		}).catch(e => ['evaluate失败: ' + e.message]);
		info.forEach(t => log('TM:', t));
		await p.close();
	} else if (cmd === 'status') {
		for (const p of ctx.pages()) {
			const s = await p.evaluate(() => ({
				url: location.href.substring(0, 60),
				bridgeTest: typeof window.__ocsBridgeTest,
				ocs: typeof window.OCS,
				aiBridge: typeof (window.OCS && window.OCS.AIBridgeProject)
			})).catch(e => ({ url: p.url().substring(0, 60), error: e.message.substring(0, 80) }));
			log(JSON.stringify(s));
		}
	} else if (cmd === 'reload') {
		const qw = ctx.pages().find(p => p.url().includes('qianwen'));
		if (!qw) { log('没找到千问页面'); return; }
		await qw.reload({ waitUntil: 'domcontentloaded' });
		await new Promise(r => setTimeout(r, 6000));
		const s = await qw.evaluate(() => ({
			bridgeTest: typeof window.__ocsBridgeTest,
			hint: (document.body.innerText || '').substring(0, 80).replace(/\n/g, '|')
		})).catch(e => ({ error: e.message }));
		log('reload后:', JSON.stringify(s));
	}
	await browser.close();
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
