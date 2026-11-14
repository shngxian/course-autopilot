const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const ctx = browser.contexts()[0];
	const page = ctx.pages().find((p) => p.url().includes('chapterId=1124773306'));
	await page.bringToFront();
	const logs = [];
	page.on('console', (m) => { const t = m.text(); if (/chapter回填|题目结果|AI答题|完成率|游离|study日志/.test(t)) { logs.push(t.slice(0, 220)); console.log('  >', t.slice(0, 200)); } });
	page.on('dialog', async (d) => { try { await d.accept().catch(() => {}); } catch {} });
	const r = await page.evaluate(() => { try { getTeacherAjax('261013119', '140568440', '1124773341'); return 'ok'; } catch (e) { return 'ERR:' + e.message; } });
	console.log('切 25.2.6（从未打开过）:', r);
	await sleep(15000);
	// 判断这章是视频还是测验
	const kind = await page.evaluate(() => {
		const walk = (win, d) => { if (d > 4 || !win) return null; try { const v = win.document.querySelector('video'); if (v) return 'video'; const t = win.document.querySelector('.TiMu'); if (t) return 'quiz'; for (let i = 0; i < win.frames.length; i++) { const r2 = walk(win.frames[i], d + 1); if (r2) return r2; } } catch {} return null; };
		return walk(window, 0) || 'unknown';
	}).catch(() => 'unknown');
	console.log('章节类型:', kind);
	if (kind === 'video') { console.log('这章要先看视频，不适合快速验证，退出'); await browser.close(); process.exit(2); }
	// 等 5 分钟观察
	for (let i = 0; i < 60; i++) {
		await sleep(5000);
		if (logs.some((l) => /完成率/.test(l))) break;
	}
	const wf = page.frames().filter((f) => /doHomeWorkNew|dowork/.test(f.url()));
	for (const f of wf.slice(0, 1)) {
		const bm = await f.evaluate(() => Array.from(document.querySelectorAll('.TiMu')).map((tm) => Array.from(tm.querySelectorAll('.num_option')).map((s) => s.className.includes('check_answer') ? 1 : 0).join('')).join(' ')).catch(() => []);
		console.log('最终回填位图:', bm);
	}
	await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
