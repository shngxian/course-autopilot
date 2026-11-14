/**
 * 雨课堂课堂答题 —— 题目检测离线验证
 *
 * 用真实 Chrome 打开三种模拟结构，验证 yuketang-lesson.ts 的检测算法
 * （可见性过滤、题目容器定位、题干/选项提取、题型判定、提交按钮查找）。
 *
 * 目的：真实课堂只有一次机会，先确认算法本身没问题，上课时只需验证选择器。
 * 用法：node test-browser/verify-ykt-lesson.js
 */const path = require('path');
const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');

const CHROME = path.resolve(__dirname, '../../ocs-desktop/bin/chrome/chrome/chrome.exe');

/** 与 yuketang-lesson.ts 保持一致的检测逻辑（测试用副本） */
const DETECT_SRC = `
const OPTION_SELECTOR = '[data-option], .options-label, .option-item, .problem-option, .choice-item';
const SUBMIT_TEXT = /^(提交|提交答案|确定|确认|交卷|保存|submit)$/i;

function isVisible(el) {
  if (!el || !(el instanceof HTMLElement) || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
}
function textOf(el) { return el ? (el.innerText || el.textContent || '') : ''; }
function detachedText(el) {
  if (!el) return '';
  const inner = el.innerText;
  if (inner && inner.trim()) return inner;
  return el.textContent || '';
}
function collectOptionsIn(scope) {
  const out = [];
  for (const el of Array.from(scope.querySelectorAll(OPTION_SELECTOR))) if (isVisible(el)) out.push(el);
  if (out.length < 2) {
    for (const input of Array.from(scope.querySelectorAll('input[type="radio"], input[type="checkbox"]'))) {
      if (!isVisible(input)) continue;
      const wrap = input.closest('label') || input.parentElement;
      if (wrap && isVisible(wrap)) out.push(wrap);
    }
  }
  const uniq = [];
  for (const el of out) {
    if (uniq.some((u) => u === el || u.contains(el))) continue;
    for (let i = uniq.length - 1; i >= 0; i--) if (el.contains(uniq[i])) uniq.splice(i, 1);
    uniq.push(el);
  }
  return uniq;
}
function collectOptions() { return collectOptionsIn(document); }
function isProblemRoot(el) {
  const opts = collectOptionsIn(el);
  if (opts.length < 2) return false;
  let rest = el.innerText || '';
  for (const o of opts) { const t = textOf(o); if (t) rest = rest.replace(t, ''); }
  return rest.replace(/\\s/g, '').length >= 4;
}
function findProblemRoots() {
  const roots = []; const seen = new Set();
  for (const opt of collectOptions()) {
    let cur = opt.parentElement;
    for (let i = 0; i < 9 && cur; i++) {
      if (isProblemRoot(cur)) { if (!seen.has(cur)) { seen.add(cur); roots.push(cur); } break; }
      cur = cur.parentElement;
    }
  }
  return roots.filter((r) => !roots.some((o) => o !== r && r.contains(o)));
}
const TIMER_SELECTOR = '[class*="countdown"], [class*="timer"], [class*="remain"], [class*="left-time"], [class*="leftTime"], [class*="clock"], [class*="cd-text"], [class*="answer-time"]';
function buildStemEl(root) {
  const clone = root.cloneNode(true);
  const killers = [OPTION_SELECTOR, TIMER_SELECTOR, 'label', 'input', 'textarea', 'button', 'script', 'style', '[class*="submit"]'].join(',');
  for (const el of Array.from(clone.querySelectorAll(killers))) el.remove();
  return clone;
}
function isJudgementLike(texts) {
  const norm = texts.map((t) => t.replace(/^[A-Za-z][.、．:：]\\s*/, '').replace(/\\s+/g, '').trim());
  if (norm.length !== 2) return false;
  const yes = /^(对|正确|是|√|✓|true|t)$/i;
  const no = /^(错|错误|否|×|✗|false|f)$/i;
  return (yes.test(norm[0]) && no.test(norm[1])) || (no.test(norm[0]) && yes.test(norm[1]));
}
function detectType(optionEls, optionTexts, root) {
  if (isJudgementLike(optionTexts)) return 'judgement';
  const hasCheckbox = optionEls.some((el) => el.matches('input[type="checkbox"]') || !!el.querySelector('input[type="checkbox"]'));
  if (hasCheckbox) return 'multiple';
  if (root.querySelector('textarea, input[type="text"]')) return 'completion';
  return 'single';
}
function findSubmitButton(scope) {
  const scan = (root) => {
    for (const el of Array.from(root.querySelectorAll('button, [class*="submit"], [class*="btn"], a'))) {
      if (!isVisible(el)) continue;
      const t = textOf(el).trim();
      if (SUBMIT_TEXT.test(t)) return el;
    }
    return null;
  };
  return scan(scope) || (scope !== document ? scan(document) : null);
}
function detect() {
  const roots = findProblemRoots();
  if (!roots.length) return null;
  const root = roots[roots.length - 1];
  const optionEls = collectOptionsIn(root);
  if (optionEls.length < 2) return null;
  const optionTexts = optionEls.map((el) => detachedText(el).trim());
  const stemEl = buildStemEl(root);
  let title = cleanStemText(detachedText(stemEl));
  if (title.length < 4) return null;
  const submitBtn = findSubmitButton(root);
  return {
    title, optionTexts, type: detectType(optionEls, optionTexts, root),
    hasSubmit: !!submitBtn, rootCount: roots.length, stemText: detachedText(stemEl).trim()
  };
}
window.__detect = detect;
window.__diag = () => {
  const opts = collectOptions();
  return {
    opts: opts.length,
    optTags: opts.map((e) => e.tagName + '.' + (e.className || '')),
    roots: findProblemRoots().length,
    stemText: (() => {
      const r = document.querySelector('.q-card');
      return r ? detachedText(buildStemEl(r)).slice(0, 60) : 'no .q-card';
    })()
  };
};
`;

/** 与 yuketang-lesson.ts 保持一致的倒计时识别逻辑（测试用副本） */
const REMAIN_SRC = `
function parseRemainText(raw) {
  const t = raw.trim();
  if (!t || t.length > 20) return null;
  let m = t.match(/(\\d{1,2}):(\\d{2})/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  m = t.match(/(?:剩余|倒计时|还剩)\\s*[:：]?\\s*(\\d{1,3})\\s*(?:秒|s)?/i);
  if (m) return parseInt(m[1], 10);
  m = t.match(/^(\\d{1,3})\\s*(?:秒|s)$/i);
  if (m) return parseInt(m[1], 10);
  return null;
}
function readRemainSeconds(root) {
  const sel = '[class*="countdown"], [class*="timer"], [class*="remain"], [class*="left-time"], [class*="leftTime"], [class*="clock"]';
  for (const scope of [root, document.body]) {
    if (!scope) continue;
    for (const el of Array.from(scope.querySelectorAll(sel))) {
      if (!isVisible(el)) continue;
      const v = parseRemainText(textOf(el));
      if (v !== null) return v;
    }
  }
  for (const el of Array.from(root.querySelectorAll('span, div, p, i, b'))) {
    const t = textOf(el).trim();
    if (!t || t.length > 16 || !/(剩余|倒计时|还剩)/.test(t)) continue;
    if (/%|次|题|人/.test(t)) continue;
    const v = parseRemainText(t);
    if (v !== null) return v;
  }
  return null;
}
window.__readRemain = readRemainSeconds;
window.__parseRemain = parseRemainText;
`;

/** 倒计时文案解析用例：[文案, 期望秒数] */
const PARSER_CASES = [
	['剩余 12 秒', 12],
	['剩余00:05', 5],
	['00:12', 12],
	['1:05', 65],
	['12s', 12],
	['12秒', 12],
	['倒计时 3', 3],
	['还剩 8 秒', 8],
	['剩余 00:12', 12],
	['剩余: 20秒', 20],
	['答题时间 30 秒', null],
	['剩余电量 50%', null]
];

/** 与 yuketang-lesson.ts 保持一致的题干清洗逻辑（测试用副本） */
const CLEAN_SRC = `
function cleanStemText(text) {
  return text
    .replace(/(?:剩余|倒计时|还剩)\\s*[:：]?\\s*(?:\\d{1,2}:\\d{2}|\\d{1,3}\\s*(?:秒|s)?)/gi, '')
    .replace(/\\d{1,2}:\\d{2}/g, '')
    .replace(/\\n{2,}/g, '\\n')
    .trim();
}
function hashKey(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
window.__cleanStem = cleanStemText;
window.__hashKey = hashKey;
`;

const CASES = [
	{
		name: 'A. 2024版雨课堂结构（.options-label + .submit-btn）',		html: `
			<div class="slide-container">
				<div class="problem-panel">
					<div class="problem-body"><p>以下哪个数是质数？</p></div>
					<div class="options">
						<div class="options-label" data-option="A">A. 4</div>
						<div class="options-label" data-option="B">B. 6</div>
						<div class="options-label" data-option="C">C. 7</div>
						<div class="options-label" data-option="D">D. 9</div>
					</div>
					<button class="submit-btn">提交</button>
				</div>
			</div>`,
		expect: { optionCount: 4, type: 'single', titleHas: '质数', hasSubmit: true }
	},
	{
		name: 'B. 通用结构（radio + label，判断题）',
		html: `
			<div class="q-card">
				<div class="q-title">判断：地球是圆的</div>
				<label><input type="radio" name="q1"> 对</label>
				<label><input type="radio" name="q1"> 错</label>
				<button>提交答案</button>
			</div>`,
		expect: { optionCount: 2, type: 'judgement', titleHas: '地球', hasSubmit: true }
	},
	{
		name: 'C. 多选题（checkbox）+ 历史题不可见',
		html: `
			<div class="old-slide" style="display:none">
				<div class="problem">
					<div>旧题目：1+1=?</div>
					<div class="option-item" data-option="A">A. 1</div>
					<div class="option-item" data-option="B">B. 2</div>
					<button class="submit-btn">提交</button>
				</div>
			</div>
			<div class="current-slide">
				<div class="problem">
					<div class="title">下列哪些属于编程语言？</div>
					<div class="option-item" data-option="A"><input type="checkbox"> Python</div>
					<div class="option-item" data-option="B"><input type="checkbox"> HTML</div>
					<div class="option-item" data-option="C"><input type="checkbox"> Java</div>
					<button class="submit-btn">提交</button>
				</div>
			</div>`,
		expect: { optionCount: 3, type: 'multiple', titleHas: '编程语言', hasSubmit: true }
	},
	{
		name: 'D. 题目未解锁（无提交按钮，应能检测到但 hasSubmit=false）',
		html: `
			<div class="problem-panel">
				<div class="problem-body">这题还没解锁</div>
				<div class="options-label" data-option="A">A. 甲</div>
				<div class="options-label" data-option="B">B. 乙</div>
			</div>`,
		expect: { optionCount: 2, type: 'single', titleHas: '解锁', hasSubmit: false }
	},
	{
		name: 'E. 倒计时识别：class 线索 + 各种文案格式',
		html: `
			<div class="problem-panel">
				<div class="problem-body">倒计时题</div>
				<div class="options-label" data-option="A">A. 甲</div>
				<div class="options-label" data-option="B">B. 乙</div>
				<button class="submit-btn">提交</button>
				<span class="answer-countdown">剩余 12 秒</span>
			</div>`,
		expect: { optionCount: 2, type: 'single', titleHas: '倒计时题', hasSubmit: true, remain: 12 }
	},
	{
		name: 'F. 倒计时防误判：页面有"剩余电量 50%"不应被当成倒计时',
		html: `
			<div class="problem-panel">
				<div class="problem-body">防误判题</div>
				<div class="options-label" data-option="A">A. 甲</div>
				<div class="options-label" data-option="B">B. 乙</div>
				<button class="submit-btn">提交</button>
				<span class="timer">剩余电量 50%</span>
			</div>`,
		expect: { optionCount: 2, type: 'single', titleHas: '防误判', hasSubmit: true, remain: null }
	}
];

(async () => {
	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

	let pass = 0;
	let fail = 0;

	for (const c of CASES) {
		await page.setContent(`<html><body>${c.html}</body></html>`);
		await page.addScriptTag({ content: DETECT_SRC });
		await page.addScriptTag({ content: REMAIN_SRC });
		await page.addScriptTag({ content: CLEAN_SRC });
		const r = await page.evaluate(() => window.__detect());

		const errs = [];
		if (!r) {
			errs.push('detect 返回 null');
		} else {
			if (r.optionTexts.length !== c.expect.optionCount) errs.push(`选项数 ${r.optionTexts.length} != ${c.expect.optionCount}`);
			if (r.type !== c.expect.type) errs.push(`题型 ${r.type} != ${c.expect.type}`);
			if (!r.title.includes(c.expect.titleHas)) errs.push(`题干缺关键词「${c.expect.titleHas}」: ${JSON.stringify(r.title.slice(0, 40))}`);
			if (r.hasSubmit !== c.expect.hasSubmit) errs.push(`提交按钮 ${r.hasSubmit} != ${c.expect.hasSubmit}`);
			if (c.name.startsWith('C') && r.rootCount !== 1) errs.push(`应只命中 1 个题目容器（历史题已隐藏），实际 ${r.rootCount}`);
			// 倒计时识别（E/F 用例）
			if ('remain' in c.expect) {
				const got = await page.evaluate(() => window.__readRemain(document.querySelector('.problem-panel')));
				if (got !== c.expect.remain) errs.push(`倒计时识别 ${got} != ${c.expect.remain}`);
			}
		}

		if (errs.length === 0) {
			pass++;
			console.log(`✅ ${c.name}`);
			console.log(`   题干: ${JSON.stringify(r.title.slice(0, 50))} | 选项: ${r.optionTexts.length} | 题型: ${r.type} | 提交: ${r.hasSubmit}`);
		} else {
			fail++;
			console.log(`❌ ${c.name}`);
			for (const e of errs) console.log('   - ' + e);
			if (r) console.log('   实际:', JSON.stringify(r).slice(0, 300));
			const diag = await page.evaluate(() => window.__diag());
			console.log('   诊断:', JSON.stringify(diag).slice(0, 400));
		}
	}

	// 倒计时文案解析：真实课堂可能出现的各种格式
	await page.setContent('<html><body><div id="probe"></div></body></html>');
	await page.addScriptTag({ content: DETECT_SRC });
	await page.addScriptTag({ content: REMAIN_SRC });
	await page.addScriptTag({ content: CLEAN_SRC });
	for (const [input, expect] of PARSER_CASES) {
		const got = await page.evaluate((t) => window.__parseRemain(t), input);
		if (got === expect) {
			pass++;
			console.log(`✅ 倒计时文案 "${input}" → ${got}`);
		} else {
			fail++;
			console.log(`❌ 倒计时文案 "${input}" → ${got}（期望 ${expect}）`);
		}
	}

	// 关键防回归：同一题只换倒计时秒数，题干清洗后的 key 必须不变
	// （不清洗的话 key 每秒都变 → 同一题被反复当新题处理，重复问 AI、重复提交）
	const keyPairs = [
		['以下哪个数是质数？\\n剩余 12 秒', '以下哪个数是质数？\\n剩余 3 秒'],
		['判断：地球是圆的 倒计时 30', '判断：地球是圆的 倒计时 8'],
		['选择题干 还剩 00:45', '选择题干 还剩 00:10'],
		['普通题干 剩余电量 50%', '普通题干 剩余电量 50%']
	];
	for (const [a, b] of keyPairs) {
		const ka = await page.evaluate((t) => window.__hashKey(window.__cleanStem(t)), a);
		const kb = await page.evaluate((t) => window.__hashKey(window.__cleanStem(t)), b);
		const cleaned = await page.evaluate((t) => window.__cleanStem(t), a);
		const same = ka === kb;
		if (same) {
			pass++;
			console.log(`✅ key 稳定: "${a.replace(/\\n.*/, '')}" → key ${ka}（清洗后: ${JSON.stringify(cleaned)}）`);
		} else {
			fail++;
			console.log(`❌ key 不稳定: ${ka} != ${kb}（题干 ${JSON.stringify(a)}）`);
		}
	}

	await browser.close();
	console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
	process.exit(fail ? 1 : 0);
})().catch((e) => {
	console.error('测试异常:', e && e.message);
	process.exit(2);
});
