const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const page = browser.contexts()[0].pages().find((p) => p.url().includes('studentstudy'));
	await page.bringToFront();
	const getP = () => page.evaluate(() => {
		const walk = (win, d) => { if (d > 4 || !win) return null; try { const v = win.document.querySelector('video'); if (v && v.currentTime > 3) return v.paused; for (let j = 0; j < win.frames.length; j++) { const r = walk(win.frames[j], d + 1); if (r !== null) return r; } } catch {} return null; };
		return walk(window, 0);
	}).catch(() => null);
	// 跨越后密集采样：0/150/300/450/600ms
	for (let k = 0; k < 3; k++) {
		await page.mouse.move(2100, 1250, { steps: 4 });
		const seq = [];
		for (const d of [0, 150, 300, 450, 600, 900]) { seq.push(((await getP()) ? 'P' : '.') + d); await sleep(d === 0 ? 150 : 150); }
		console.log('移出后:', seq.join(' '));
		await page.mouse.move(520, 420, { steps: 4 });
		await sleep(600);
	}
	await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
