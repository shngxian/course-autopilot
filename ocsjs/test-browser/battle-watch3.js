/** 实战监控：新课程刷课全程（题目/桥接/对话复用/并发/视频/回填） */
const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const ctx = browser.contexts()[0];
	const page = ctx.pages().find((p) => p.url().includes('studentstudy'));
	if (!page) { console.log('学习页不在'); process.exit(1); }
	const qws = ctx.pages().filter((p) => /qianwen/.test(p.url()));

	const logs = [];
	page.on('console', (m) => {
		const t = m.text();
		if (/study日志|AI桥接|AI答题|message \(info|success|warn\)|完成率|保存|提交|开始答|题目结果|桥接/.test(t) && !/fail of find top/.test(t)) {
			logs.push(t.substring(0, 250));
			console.log('  >', t.substring(0, 220));
		}
	});
	page.on('pageerror', (e) => console.log('  [err]', String(e).substring(0, 150)));

	let lastQ = '', lastA = '', lastStat = '';
	for (let i = 0; i < 360; i++) {
		await sleep(5000);
		const t = `t+${(((i + 1) * 5) / 60).toFixed(1)}m`;
		let st = null;
		try {
			st = await page.evaluate(() => {
				const g = (k, d) => { try { return String(GM_getValue(k, d ?? '')); } catch { return 'ERR'; } };
				let inflight = 0;
				try { inflight = Object.keys(JSON.parse(g('ai_bridge_inflight', '{}')) || {}).length; } catch {}
				let chatUse = '';
				try { const u = JSON.parse(g('ai_bridge_chat_use', '{}')); chatUse = (u && u.count != null) ? String(u.count) : '?'; } catch {}
				return { q: g('ai_bridge_question', '').substring(0, 200), a: g('ai_bridge_answer', '').substring(0, 200), inflight, chatUse };
			});
		} catch { continue; }
		if (st.q && st.q !== lastQ) { console.log(`${t} Q:`, st.q.replace(/\n/g, '⏎').substring(0, 160)); lastQ = st.q; }
		if (st.a && st.a !== lastA) {
			const t2 = `${t} A:`, body = st.a.replace(/\n/g, '⏎');
			console.log(t2, body.substring(0, 170));
			lastA = st.a;
		}
		const statKey = st.inflight + '|' + st.chatUse;
		if (statKey !== lastStat && i % 2 === 0) { console.log(`${t} [桥接态] 并发在途=${st.inflight}/3 对话已用=${st.chatUse}题`); lastStat = statKey; }

		// 千问侧：各标签页忙碌状态（data-ocs-bridge）
		if (i % 6 === 5) {
			for (let j = 0; j < qws.length; j++) {
				try {
					const bs = await qws[j].evaluate(() => document.documentElement.getAttribute('data-ocs-bridge') || '').catch(() => '');
					if (bs) console.log(`${t} [千问#${j + 1}]`, bs.substring(0, 120));
				} catch {}
			}
		}
		// 作业帧回填状态
		const wf = page.frames().filter((f) => /ananas\/modules\/work|dowork|doHomeWorkNew|selectWork/.test(f.url()));
		if (wf.length && i % 4 === 2) {
			for (const f of wf) {
				try {
					const r = await f.evaluate(() => {
						const timus = Array.from(document.querySelectorAll('.TiMu'));
						return timus.map((tm, idx) => `#${idx + 1}答${tm.querySelectorAll('li.check,.check,input:checked').length}图${tm.querySelectorAll('img').length}`).join(' ');
					}).catch(() => null);
					if (r) console.log(`${t} [题目] ${r}`);
				} catch {}
			}
		}
		// 视频状态
		if (i % 10 === 4) {
			try {
				const v = await page.evaluate(() => {
					const frames = Array.from(document.querySelectorAll('iframe'));
					for (const f of frames) {
						try {
							const v1 = f.contentDocument && f.contentDocument.querySelector('video');
							if (v1) return `视频: ${Math.round(v1.currentTime)}/${Math.round(v1.duration)}s ${v1.paused ? '暂停' : '播放中'}`;
						} catch {}
					}
					return null;
				}).catch(() => null);
				if (v) console.log(`${t} [${v}]`);
			} catch {}
		}
	}
	console.log('\n=== 关键消息（末30条）===');
	logs.filter((l) => /完成率|保存|提交|开始|题目结果|得到答案|桥接/.test(l)).slice(-30).forEach((l) => console.log(' ', l));
	await browser.close();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
