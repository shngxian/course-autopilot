/** E2E：新角标样式（左侧补白条）+ 图片顺序断言 + AI 按编号角标作答 */
const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const ctx = browser.contexts()[0];
	const qw = ctx.pages().find((p) => /qianwen/.test(p.url()));
	if (!qw) { console.log('千问页不在'); process.exit(1); }
	await qw.bringToFront();
	qw.on('console', (m) => {
		const t = m.text();
		if (/AI桥接/.test(t)) console.log('  [桥接]', t.substring(0, 140));
	});
	await sleep(2000);

	// 每张图唯一宽度：题干640，选项460/470/480/490（提示词图固定820）→ 用于顺序断言
	const sent = await qw.evaluate(async () => {
		const make = (text, w) => {
			const c = document.createElement('canvas');
			c.width = w; c.height = 80;
			const x = c.getContext('2d');
			x.fillStyle = '#fff'; x.fillRect(0, 0, w, 80);
			x.fillStyle = '#222'; x.font = '30px serif';
			x.fillText(text, 20, 52);
			return c.toDataURL('image/png');
		};
		// 新版角标：左侧补白条（与 drawOptionLabel 一致）
		const label = (base64, letter, color) => new Promise((res) => {
			const im = new Image();
			im.onload = () => {
				const w = im.naturalWidth, h = im.naturalHeight;
				const c = document.createElement('canvas');
				const x = c.getContext('2d');
				const fontSize = Math.min(96, Math.max(16, Math.round(h * 0.45)));
				const pad = Math.round(fontSize * 0.35);
				const badgeW = fontSize + pad * 2;
				const badgeH = Math.min(h, Math.round(fontSize * 1.25));
				const stripW = Math.round(badgeW + fontSize * 0.3);
				c.width = w + stripW; c.height = h;
				x.fillStyle = '#ffffff'; x.fillRect(0, 0, stripW, h);
				x.drawImage(im, stripW, 0);
				const bx = Math.round((stripW - badgeW) / 2), by = Math.round((h - badgeH) / 2);
				x.fillStyle = color || '#e53935'; x.fillRect(bx, by, badgeW, badgeH);
				x.fillStyle = '#fff'; x.font = 'bold ' + fontSize + 'px Arial, sans-serif';
				x.textAlign = 'center'; x.textBaseline = 'middle';
				x.fillText(letter, bx + badgeW / 2, by + badgeH / 2 + 1);
				res(c.toDataURL('image/png'));
			};
			im.src = base64;
		});
		const stemImg = await label(make('下列函数中在[-1,1]上满足罗尔定理的函数是', 640), '题', '#1e88e5');
		const texts = ['y = x² + 1', 'y = |x|', 'y = x³ + 1', 'y = ∛(x²)'];
		const widths = [460, 470, 480, 490];
		const imgs = [];
		for (let i = 0; i < 4; i++) imgs.push(await label(make(texts[i], widths[i]), String.fromCharCode(65 + i)));

		// 与 buildQuestionPrompt 新格式一致（含新角标措辞）
		const text = '本题的问题是：[图片]\n\n请解答这道单选题。（选项内容在图片中，必须依据上面的题干问题和图片选项作答；每个选项图片的左侧空白条上都用红色角标标注了对应的选项字母（角标在图片外侧，不遮挡内容），请按角标字母识别选项）\n图片说明：本条消息共有 6 张图片，其中一张是题目说明文字，内容与本段提示词相同；题干原图共 1 张，左侧空白条上有蓝色「题」字角标（角标在图片外侧，不遮挡内容）；选项图片左侧空白条上有红色角标，角标上的字母即选项字母（纯文字选项无对应图片，已在选项列表中给出）。聊天窗口中图片的排列顺序可能与题目中的出现顺序不同，请按上述特征识别每张图片的含义，不要按排列顺序推断。题目文字中的 [图片] 即指这些图片。\nA [图片]\nB [图片]\nC [图片]\nD [图片]\n\n只输出答案\n注意：回答可以先简要分析，但最后必须单独一行给出结论，格式必须是「最终答案：X」（单选题 X 为选项字母 A/B/C/D；多选题为字母组合如 AB；判断题 X 为 对 或 错；填空题 X 为具体答案）。选择题即使不确定也必须从选项中选一个字母作答，禁止用数字或文字描述代替选项字母。';

		const qid = 'badge_e2e_' + Date.now();
		const queue = JSON.parse(String(GM_getValue('ai_bridge_queue', '')) || '{}') || {};
		queue[qid] = { id: qid, text, images: [stemImg, ...imgs], site: 'qianwen', timestamp: Date.now() };
		GM_setValue('ai_bridge_queue', JSON.stringify(queue));
		GM_setValue('ai_bridge_knock', String(Date.now()));
		return qid;
	});
	console.log(sent, '| 期望顺序宽度: 提示词820 → 题干640 → 选项 533/543/553/563（460/470/480/490+左条73）');

	// 顺序断言：等消息出现后读各图 naturalWidth
	let orderChecked = false;
	const t0 = Date.now();
	while (Date.now() - t0 < 15000 && !orderChecked) {
		await sleep(2500);
		try {
			const widths = await qw.evaluate(() => {
				const q = Array.from(document.querySelectorAll('.message-card-wrap.question')).pop();
				if (!q) return null;
				const imgs = Array.from(q.querySelectorAll('img'));
				return imgs.length >= 6 ? imgs.map((i) => i.naturalWidth) : null;
			});
			if (widths) {
				console.log('实际消息图片宽度序列:', widths.join(' → '));
				const expect = [820, 640, 533, 543, 553, 563];
				const ok = widths.length === 6 && widths.every((w, i) => Math.abs(w - expect[i]) <= 2);
				console.log('顺序断言:', ok ? '✓ 完全一致（提示词→题干→选项A~D）' : (widths.length === 6 ? '✗ 顺序或尺寸不符，需人工判断' : ''));
				orderChecked = true;
			}
		} catch {}
	}
	if (!orderChecked) console.log('顺序断言: 未捕获消息（跳过）');

	// 等答案
	const start = Date.now();
	let answer = '';
	while (Date.now() - start < 150000) {
		await sleep(5000);
		try {
			answer = await qw.evaluate((qid) => { try { return String(GM_getValue('ai_bridge_answer_' + qid, '')); } catch { return ''; } }, result);
		} catch {}
		if (answer.includes('最终答案')) break;
	}
	console.log('\n=== AI 回答（前400字）===');
	console.log((answer || '(超时无回答)').slice(0, 400));
	console.log('\n=== 尾部 ===');
	console.log(answer.slice(-150));
	process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
