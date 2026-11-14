const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const page = browser.contexts()[0].pages().find((p) => p.url().includes('studentstudy'));
	await page.bringToFront();
	await page.evaluate(() => location.reload()).catch(() => {});
	// 轮询等 OCS 就绪（chaoxing 加载慢）
	let out = null;
	for (let i = 0; i < 20; i++) {
		await sleep(3000);
		try {
			out = await page.evaluate(() => {
				if (typeof OCS === 'undefined' || !OCS.buildQuestionPrompt) return null;
				const r = OCS.buildQuestionPrompt(
					{ systemPrompt: '' },
					{
						title: 'https://p.ananas.chaoxing.com/logo.png?xxxxxxxxxxxxxxxxxxxx',
						options: ['https://p.ananas.chaoxing.com/logo2.png?yyyyyyyyyyyy', 'https://p.ananas.chaoxing.com/logo3.png?zzzzzzzzzzzz', '3', '0'],
						type: 'single',
						stemImageCount: 1
					},
					['data:image/png;base64,AAA', 'data:image/png;base64,BBB', 'data:image/png;base64,CCC'],
					true
				);
				const c = r.messages[0].content;
				const text = typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
				return { text, parts: Array.isArray(c) ? c.length : 1 };
			});
			if (out) break;
		} catch { continue; }
	}
	if (!out) { console.log('OCS 未就绪'); process.exit(1); }
	console.log('multimodal parts:', out.parts, '(1文字 + 3图)');
	console.log('--- 生成的提示词 ---');
	console.log(out.text);
	await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
