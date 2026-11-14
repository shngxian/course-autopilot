/**
 * 雨课堂实时课堂侦察工具（上课时用，跑完 Ctrl+C 停止）
 *
 * 用法：
 *   打开课堂页后，命令行执行：
 *     node test-browser/probe-ykt-live.js
 *   （需要 launch-user.js 在跑，CDP 9223；不带参数会自动找页面里的雨课堂标签）
 *
 * 做三件事：
 *   1. 周期性抓课堂页 DOM 摘要：题目容器/选项元素/提交按钮/倒计时/字体加密
 *   2. 拦截 presentation、fetch 等接口：记录题目是否提前下发、problem 里有没有 answers
 *   3. 全部落盘 test-browser/ykt-live-report.json，下课后拿它改选择器
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');

const REPORT = path.resolve(__dirname, 'ykt-live-report.json');
const CDP = process.env.CDP_PORT || '9223';

const report = {
	startedAt: new Date().toISOString(),
	pages: [],
	apis: [],
	snapshots: []
};

(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:' + CDP);
	const ctx = browser.contexts()[0];

	// 找雨课堂页面
	let page = ctx.pages().find((p) => /yuketang\.cn/.test(p.url()));
	if (!page) {
		console.log('❌ 没找到雨课堂标签页。请先打开课堂页（老师上课那个），再跑本脚本。');
		console.log('当前标签页：');
		for (const p of ctx.pages()) console.log('   ' + (p.url() || '').slice(0, 80));
		process.exit(1);
	}
	await page.bringToFront().catch(() => {});
	console.log('目标页面: ' + (page.url() || '').slice(0, 100));

	// ---------- 1. 接口拦截 ----------
	const apiHit = (url) => /presentation|problem|lesson|classroom|\/fetch|checkin|answer/i.test(url);
	page.on('response', async (res) => {
		try {
			const url = res.url();
			if (!apiHit(url)) return;
			let body = '';
			try {
				body = (await res.text()).slice(0, 4000);
			} catch {}
			const fields = ['answers', 'answer', 'problem', 'problems', 'body', 'options', 'correct', 'blanks'].filter((k) =>
				body.includes('"' + k + '"')
			);
			const rec = {
				t: new Date().toISOString(),
				url: url.replace(/^https?:\/\/[^/]+/, '').slice(0, 140),
				status: res.status(),
				len: body.length,
				fields,
				// 有 answers/correct 时留样本，最能说明"答案是否下发"
				sample: /"answers"|"correct"/.test(body) ? body.slice(0, 1200) : undefined
			};
			report.apis.push(rec);
			console.log('[接口] ' + rec.url.slice(0, 90) + '  字段: ' + (fields.join(',') || '(无)'));
		} catch {}
	});

	// ---------- 2. DOM 周期快照 ----------
	const OPTION_SELS = [
		'[data-option]',
		'.options-label',
		'.option-item',
		'.problem-option',
		'input[type=radio]',
		'input[type=checkbox]',
		'[aria-checked]',
		'.choice-item'
	];
	const snap = async () => {
		try {
			const s = await page.evaluate((sels) => {
				const out = { t: new Date().toISOString(), url: location.pathname.slice(0, 60) };
				out.hits = {};
				for (const s of sels) {
					const els = Array.from(document.querySelectorAll(s)).filter((e) => e.offsetParent !== null);
					if (els.length) out.hits[s] = els.length;
				}
				// 提交按钮
				out.submitBtns = Array.from(document.querySelectorAll('button, [role=button]'))
					.filter((e) => /提交|确认|确定/.test((e.innerText || '') + (e.getAttribute('aria-label') || '')) && e.offsetParent)
					.map((e) => ((e.innerText || '').trim() || (e.getAttribute('aria-label') || '')).slice(0, 14))
					.slice(0, 5);
				// 倒计时线索
				out.timerHints = Array.from(
					document.querySelectorAll('[class*="countdown"],[class*="timer"],[class*="remain"],[class*="leftTime"]')
				)
					.filter((e) => e.offsetParent)
					.map((e) => ((e.textContent || '').trim().slice(0, 18) + ' @' + (typeof e.className === 'string' ? e.className : '').slice(0, 34)))
					.filter((x) => x.trim() && x.length > 6)
					.slice(0, 5);
				// 倒计时文案线索（含"剩余/倒计时"的短文本）
				out.timerTexts = Array.from(document.querySelectorAll('span,div,p,i,b'))
					.map((e) => (e.textContent || '').trim())
					.filter((t) => t.length <= 16 && /剩余|倒计时|还剩/.test(t))
					.slice(0, 5);
				// 字体加密
				out.encryptedFont = document.querySelectorAll('.xuetangx-com-encrypted-font, [class*="encrypted-font"]').length;
				// 关键 class 采样
				const cls = new Set();
				for (const el of document.querySelectorAll('[class*="problem"],[class*="option"],[class*="timer"],[class*="countdown"],[class*="slide"]')) {
					const c = typeof el.className === 'string' ? el.className : '';
					if (c) cls.add(c.slice(0, 60));
					if (cls.size > 25) break;
				}
				out.classes = Array.from(cls);
				// 页面文字（判断是否在答题页）
				out.textHead = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 220);
				return out;
			}, OPTION_SELS);

			const interesting = Object.keys(s.hits || {}).length > 0 || (s.submitBtns || []).length > 0;
			const changed = JSON.stringify(s) !== JSON.stringify(report.snapshots[report.snapshots.length - 1]);
			if (interesting && changed) {
				report.snapshots.push(s);
				console.log(
					`[DOM ${new Date().toLocaleTimeString()}] 选项命中 ${JSON.stringify(s.hits)} 提交=${JSON.stringify(s.submitBtns)} 倒计时=${JSON.stringify(s.timerHints)}`
				);
				if (s.encryptedFont) console.log('      ⚠️ 检测到字体加密元素 x' + s.encryptedFont);
			}
		} catch {}
	};

	console.log('\n开始监听（老师推题/翻页时会自动记录）。停止 = Ctrl+C\n');
	await snap();
	setInterval(snap, 2000);

	// ---------- 3. 落盘 ----------
	const save = () => {
		try {
			fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
			console.log('\n报告已保存: ' + REPORT);
			console.log('  接口记录 ' + report.apis.length + ' 条，DOM 快照 ' + report.snapshots.length + ' 个');
		} catch (e) {
			console.log('报告保存失败: ' + e.message);
		}
	};
	process.on('SIGINT', () => {
		save();
		process.exit(0);
	});
	setInterval(save, 30000); // 防止忘记保存
})().catch((e) => {
	console.error('启动失败:', e && e.message);
	console.error('（确认 launch-user.js 正在运行，浏览器已打开）');
	process.exit(2);
});
