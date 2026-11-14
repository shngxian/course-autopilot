/**
 * AI 桥接脚本（多站点适配器架构）
 *
 * 运行在 AI 聊天网页上（千问、智谱清言等），监听答题页面发来的问题，
 * 模拟真人操作（输入 → 发送 → 等待 → 提取回答），通过 GM 存储返回答案。
 *
 * 每个 AI 站点一个适配器，在设置中选择使用哪个。
 */

import { $, Project, Script } from 'easy-us';
import { subjectKey } from '@ocsjs/core';
import { trustedClick, trustedClickFire } from '../utils/work';

/** 桥接协议的存储键 */
export const BRIDGE_QUESTION_KEY = 'ai_bridge_question';
export const BRIDGE_ANSWER_KEY = 'ai_bridge_answer';

type BridgeQuestion = {
	id: string;
	text: string;
	images?: string[];
	/** 目标站点标识（qianwen / chatglm），空则所有站点都响应 */
	site?: string;
	timestamp: number;
};

type BridgeAnswer = {
	id: string;
	answer: string;
	error?: string;
	timestamp: number;
};

/* ------------------------------------------------------------------ */
/*  站点适配器接口                                                      */
/* ------------------------------------------------------------------ */

export interface SiteAdapter {
	/** 站点标识（用于桥接匹配） */
	siteId: string;
	name: string;
	/** 匹配的域名 */
	domains: string[];
	/** 找到输入框 */
	findInput(): HTMLElement | null;
	/** 向输入框写入文字（返回是否成功） */
	inputText(text: string): Promise<boolean>;
	/** 点击发送按钮 */
	clickSend(): boolean;
	/**
	 * 清空输入框（重发前用）。
	 * 绝不能触发页面跳转 —— 跳转会销毁当前 JS 上下文，答案永远写不回去。
	 */
	resetInput(): Promise<void>;
	/** 新建对话（可能触发页面跳转，仅限显式换对话时使用） */
	newChat(): Promise<void>;
	/** 获取最后一条 AI 回答文本 */
	getResponse(): string | null;
	/** AI 是否正在生成中 */
	isGenerating(): boolean;
	/** 上传图片（可选） */
	uploadImages?(images: string[]): Promise<boolean>;
	/** 图片+文字一次性输入（可选；实测千问必须同一粘贴事件携带，分开粘贴会导致消息损坏AI不响应） */
	inputWithImages?(text: string, images: string[]): Promise<boolean>;
	/**
	 * 是否把提示词渲染成图片再发送。
	 * 默认 true：所有站点统一走「提示词图 + 题图」，只是发送手段不同（千问粘贴、其余上传附件）。
	 * 千问是必须的——它的编辑器会丢弃粘贴事件里的 text/plain，文字只能靠图片传过去。
	 */
	needsPromptAsImage?: boolean;
}

/* ------------------------------------------------------------------ */
/*  通用工具                                                            */
/* ------------------------------------------------------------------ */

function dataURLtoFile(dataurl: string, filename: string): File | null {
	try {
		const arr = dataurl.split(',');
		const mimeMatch = arr[0].match(/:(.*?);/);
		if (!mimeMatch) return null;
		const bstr = atob(arr[1]);
		let n = bstr.length;
		const u8arr = new Uint8Array(n);
		while (n--) u8arr[n] = bstr.charCodeAt(n);
		return new File([u8arr], filename, { type: mimeMatch[1] });
	} catch {
		return null;
	}
}

/**
 * 上传图片（多策略适配）
 *
 * 策略1: 页面已有 input[type=file] → 直接注入
 * 策略2: 打开附件菜单，找"上传图片"，拦截动态创建的 input
 * 策略3: 写入真实剪贴板（GM_setClipboard）再模拟粘贴
 */
/**
 * 回答是否在表示"没收到附件"——图片题上传失败（JS 假上传）的典型信号。
 * 只在短回答上判定：失败信号通常就一句话（"请提供图片。"）；
 * 正常回答复述题干时可能带上"请提供图片中的…"，不能一棍子打死。
 */
function isAttachmentMissing(text: string): boolean {
	if (!text || text.trim().length > 80) return false;
	return (
		/没(有)?(看到|收到|识别到|读取到|找到).{0,10}(附件|图片|图像|配图)/i.test(text) ||
		/请.{0,10}(提供|重新发送|重新上传|上传|发一下|发给我).{0,10}(图片|附件|图像)/i.test(text) ||
		/无法(查看|读取|识别|解析|打开).{0,8}(图片|附件|图像)/i.test(text)
	);
}

/**
 * 通过 CDP 守护进程做真实文件上传。
 *
 * 为什么要这个：JS 里 `input.files = dt.files` 对有些站点只是"假选择"——React 收到了
 * change 事件、渲染出缩略图，但浏览器并没有走真实的文件选择流程，附件根本没上传到服务器
 * （扣子实测：页面有预览，AI 却说"没看到附件"）。
 * Playwright 的 setInputFiles 走 CDP `DOM.setFileInputFiles`，浏览器当成真实选择，才会真正上传。
 *
 * 依赖 launch-user.js 的守护进程（无守护进程时返回 false，由调用方降级）。
 */
async function cdpUploadImages(images: string[]): Promise<boolean> {
	try {
		const dataUrls = images.filter((u) => typeof u === 'string' && u.startsWith('data:'));
		if (!dataUrls.length) return false;

		const top: any = window.top;
		if (!top || top === window) return false;

		// 守护进程每 400ms 扫一遍并会打下 __cdpDaemon 标记，稍微等一下
		for (let i = 0; i < 5 && !top.__cdpDaemon; i++) await $.sleep(300);
		if (!top.__cdpDaemon) return false;

		const id = 'up_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
		top.__cdpUploads = top.__cdpUploads || [];
		top.__cdpUploads.push({ id, files: dataUrls });

		const t0 = Date.now();
		while (Date.now() - t0 < 15000) {
			await $.sleep(200);
			if (top.__cdpUploadResults && top.__cdpUploadResults[id]) {
				const ok = !!top.__cdpUploadResults[id].ok;
				delete top.__cdpUploadResults[id];
				return ok;
			}
		}
		return false;
	} catch {
		return false;
	}
}

async function genericUploadImages(images: string[]): Promise<boolean> {
	// 优先走 CDP 真实上传（能真正上传到服务端）
	if (await cdpUploadImages(images)) return true;

	const dataUrls = images.filter((u) => u.startsWith('data:'));
	if (!dataUrls.length) return false;
	const files = dataUrls.map((u, i) => dataURLtoFile(u, `img_${Date.now()}_${i}.png`)).filter(Boolean) as File[];
	if (!files.length) return false;

	// 策略 1：已有 file input（新页面 composer 可能还没渲染，最多等 3 秒）
	let existing = document.querySelector('input[type="file"]') as HTMLInputElement | null;
	for (let i = 0; !existing && i < 6; i++) {
		await $.sleep(500);
		existing = document.querySelector('input[type="file"]') as HTMLInputElement | null;
	}
	if (existing) {
		const dt = new DataTransfer();
		files.forEach((f) => dt.items.add(f));
		existing.files = dt.files;
		existing.dispatchEvent(new Event('change', { bubbles: true }));
		// 附件上传到服务器需要时间，等不够就发送会变成「AI 说没收到图片」
		await $.sleep(4000);
		return true;
	}

	// 策略 2：写真实剪贴板 + 模拟粘贴（对 React 富文本编辑器最可靠）
	try {
			// dataURL → Blob
			const blob = await (await fetch(dataUrls[0])).blob();
			// 写入剪贴板（需要 ClipboardItem，Chrome 76+）
			if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
				const clipData: any = {};
				clipData[blob.type] = blob;
				await navigator.clipboard.write([new ClipboardItem(clipData)]);
				await $.sleep(300);
				// 模拟 Ctrl+V 粘贴
				const editor = document.querySelector('[contenteditable="true"], textarea') as HTMLElement | null;
				if (editor) {
					editor.focus();
				document.execCommand('paste');
				await $.sleep(2000);
				return true;
			}
		}
	} catch (e) {
		console.warn('[AI桥接] 剪贴板粘贴失败:', e);
	}

	// 策略 3：粘贴事件携带 File（部分编辑器支持）
	try {
		const editor = document.querySelector('[contenteditable="true"], textarea') as HTMLElement | null;
		if (editor) {
			editor.focus();
			const dt = new DataTransfer();
			files.forEach((f) => dt.items.add(f));
			editor.dispatchEvent(new ClipboardEvent('paste', {
				clipboardData: dt, bubbles: true, cancelable: true
			}));
			await $.sleep(2000);
			return true;
		}
	} catch (e) {
		console.warn('[AI桥接] 粘贴事件失败:', e);
	}

	// 策略 4：拦截动态创建的 input（Radix 菜单流程）
	return await new Promise<boolean>((resolve) => {
		let resolved = false;
		const finish = (ok: boolean) => {
			if (!resolved) { resolved = true; resolve(ok); }
		};

		const origClick = HTMLInputElement.prototype.click;
		HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
			if (this.type === 'file') return;
			return origClick.call(this);
		};

		const observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				for (const node of Array.from(m.addedNodes)) {
					if (node.nodeType !== 1) continue;
					const el = node as Element;
					const inputs: HTMLInputElement[] = el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file'
						? [el as HTMLInputElement]
						: el.querySelectorAll ? Array.from(el.querySelectorAll('input[type="file"]')) : [];
					for (const inp of inputs) {
						observer.disconnect();
						HTMLInputElement.prototype.click = origClick;
						const dt = new DataTransfer();
						files.forEach((f) => dt.items.add(f));
						inp.files = dt.files;
						inp.dispatchEvent(new Event('change', { bubbles: true }));
						setTimeout(() => finish(true), 2000);
						return;
					}
				}
			}
		});
		observer.observe(document.body, { childList: true, subtree: true });

		// 用 PointerEvent 序列点附件按钮（Radix UI 需要）
		const btn = Array.from(document.querySelectorAll('button')).find((b) =>
			(b.getAttribute('aria-label') || '').includes('附件') || (b.textContent || '').includes('附件')
		);
		if (btn) {
			const rect = (btn as HTMLElement).getBoundingClientRect();
			const opts = {
				bubbles: true, cancelable: true,
				clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
				button: 0, buttons: 1
			};
			btn.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
			btn.dispatchEvent(new MouseEvent('mousedown', opts));
			btn.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
			btn.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
			btn.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
		}

		setTimeout(() => {
			observer.disconnect();
			HTMLInputElement.prototype.click = origClick;
			finish(false);
		}, 5000);
	});
}

/**
 * 等待回答完成
 *
 * 实测（2026-09-21 采样验证）：当前千问 UI 生成期间没有"停止"按钮（isGenerating 恒 false），
 * 文本分两段到达（流式正文 + 公式渲染大跳变），公式密集回答的中途停顿可超过 10 秒——
 * 纯稳定性判定会提前返回半截答案。
 *
 * 因此以提示词强制的「最终答案」标记作为主完成信号：
 * - 出现结束标记且文本稳定 5 秒 → 完成（快）
 * - 未出现标记（AI 未按格式回答）→ 20 秒稳定兜底（慢但保险）
 */
async function waitForResponse(adapter: SiteAdapter, prevText: string, timeout = 120000, finishMarker = '最终答案'): Promise<string> {
	const start = Date.now();
	let lastText = '';
	let lastChangeTime = Date.now();
	let started = false;

	while (Date.now() - start < timeout) {
		await $.sleep(1000);
		const text = adapter.getResponse() || '';

		if (!started) {
			// 根治「误判 AI 未开始回答」：
			// 旧逻辑：started = isGenerating() || (text !== prevText)
			// prevText 是【发送前】那一刻的回答文本（通常是上一题的答案）。
			// 若两题答案碰巧相同（实测：生态安全与社会安全都是"最终答案：ABCD"），
			// text !== prevText 恒为 false → started 永不置位 → 60 秒后误抛
			// "AI 未开始回答" → 触发重发 → 同一题在 AI 聊天里出现多次。
			//
			// 新逻辑：发送后只要【读到任何非空文本】就算 AI 开始回答了。
			// 完全不跟 prevText 比较——是否"新回答"由后面的稳定性判定负责
			// （文本连续 N 秒不变即视为完成），不会因为答案撞车而失效。
			if (adapter.isGenerating() || (text && text.trim().length > 0)) {
				started = true;
				lastText = text;
				lastChangeTime = Date.now();
			} else if (Date.now() - start > 60000) {
				throw new Error('发送后 60 秒内 AI 未开始回答（发送可能失败或被拦截）');
			}
			continue;
		}

		if (text && text !== lastText) {
			lastText = text;
			lastChangeTime = Date.now();
		}
		if (!lastText || adapter.isGenerating()) continue;

		const hasMarker = !!finishMarker && lastText.includes(finishMarker);
		const stableMs = hasMarker ? 5000 : 20000;
		if (Date.now() - lastChangeTime > stableMs) {
			// 二次确认：再读一次，文本没变才算真完成（防止停顿误判）
			await $.sleep(hasMarker ? 2000 : 3000);
			const confirmText = adapter.getResponse() || '';
			if (confirmText === lastText) return lastText;
			if (confirmText && confirmText !== lastText) {
				lastText = confirmText;
				lastChangeTime = Date.now();
			}
		}
	}
	return lastText || '';
}

/* ------------------------------------------------------------------ */
/*  千问适配器（qianwen.com）— 已实测验证                                */
/* ------------------------------------------------------------------ */

const QwenAdapter: SiteAdapter = {
	siteId: 'qianwen',
	name: '千问',
	domains: ['qianwen.com', 'www.qianwen.com', 'tongyi.com'],

	findInput(): HTMLElement | null {
		return document.querySelector('[contenteditable="true"]');
	},

	async inputText(text: string): Promise<boolean> {
		const el = this.findInput();
		if (!el) return false;
		// 千问用 React 富文本编辑器：模拟粘贴事件（实测有效），粘贴后校验是否真的写入
		const head = text.slice(0, 20);
		for (let i = 0; i < 3; i++) {
			el.focus();
			const dt = new DataTransfer();
			dt.setData('text/plain', text);
			el.dispatchEvent(new ClipboardEvent('paste', {
				clipboardData: dt,
				bubbles: true,
				cancelable: true
			}));
			await $.sleep(500);
			if ((el.textContent || '').includes(head)) return true;
			console.warn('[AI桥接] 粘贴第 ' + (i + 1) + ' 次未生效，重试...');
		}
		return false;
	},

	clickSend(): boolean {
		const btns = document.querySelectorAll('button');
		for (const b of Array.from(btns)) {
			const label = b.getAttribute('aria-label') || '';
			if (label.includes('发送') && !b.disabled) {
				// 优先 CDP 真实点击（isTrusted=true），无守护进程时降级 JS 点击
				// 点击由守护进程异步执行（~百毫秒级），发送结果由后续 waitForResponse 兜底
				trustedClickFire(b as HTMLElement);
				return true;
			}
		}
		return false;
	},

	async resetInput(): Promise<void> {
		await clearInput(this.findInput());
	},

	async newChat(): Promise<void> {
		const btns = document.querySelectorAll('button');
		for (const b of Array.from(btns)) {
			if (b.textContent?.includes('新建对话')) {
				b.click();
				await $.sleep(1500);
				return;
			}
		}
	},

	getResponse(): string | null {
		const mds = document.querySelectorAll('.qk-markdown');
		let lastMd = '';
		mds.forEach((m) => {
			const t = m.textContent?.trim();
			if (t) lastMd = t;
		});
		return lastMd || null;
	},

	isGenerating(): boolean {
		return Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('停止'));
	},

	/**
	 * 图片+文字一次性粘贴（千问实测验证的唯一可靠方式）
	 *
	 * 同一 DataTransfer 同时携带 File 和 text/plain，一次 paste 事件完成。
	 * 注意（实测结论）：
	 * - 图片和文字必须同一粘贴事件：分开两次粘贴会导致附件状态损坏，AI 永不响应
	 * - 文字不会显示在编辑器里（被图片占位），但会随消息一起发送
	 * - 前提已登录（未登录时附件功能被静默禁用）
	 */
	async inputWithImages(text: string, images: string[]): Promise<boolean> {
		const editor = this.findInput();
		if (!editor) return false;
		const files = images
			.filter((u) => u.startsWith('data:'))
			.map((u, i) => dataURLtoFile(u, 'image_' + Date.now() + '_' + i + '.png'))
			.filter(Boolean) as File[];
		if (!files.length) return false;

		editor.focus();
		const dt = new DataTransfer();
		files.forEach((f) => dt.items.add(f));
		dt.setData('text/plain', text);
		editor.dispatchEvent(new ClipboardEvent('paste', {
			clipboardData: dt,
			bubbles: true,
			cancelable: true
		}));
		await $.sleep(2500);

		// 校验：输入区出现真实图片预览（CDN/blob 地址，排除 SVG 图标）
		const uploaded = Array.from(document.querySelectorAll('img')).some((img) => {
			const src = img.src || '';
			if (src.startsWith('data:image/svg')) return false;
			const r = img.getBoundingClientRect();
			return r.width > 40 && r.height > 40;
		});
		if (!uploaded) console.warn('[AI桥接] 图文粘贴后未见图片预览（可能未登录或上传失败）');
		return uploaded;
	},

	/**
	 * 上传图片（单独粘贴方式 — 仅当无 inputWithImages 时的回退路径）
	 */
	async uploadImages(images: string[]): Promise<boolean> {
		const dataUrls = images.filter((u) => u.startsWith('data:'));
		if (!dataUrls.length) return false;
		const editor = this.findInput();
		if (!editor) return false;
		let ok = 0;
		for (const u of dataUrls) {
			try {
				const file = dataURLtoFile(u, 'image_' + Date.now() + '_' + ok + '.png');
				if (!file) continue;
				editor.focus();
				const dt = new DataTransfer();
				dt.items.add(file);
				editor.dispatchEvent(new ClipboardEvent('paste', {
					clipboardData: dt,
					bubbles: true,
					cancelable: true
				}));
				await $.sleep(2500);
				// 校验：输入区出现非 SVG 的真实图片预览（CDN 或 blob 地址）
				const uploaded = Array.from(document.querySelectorAll('img')).some((img) => {
					const src = img.src || '';
					if (src.startsWith('data:image/svg')) return false;
					const r = img.getBoundingClientRect();
					return r.width > 40 && r.height > 40;
				});
				if (uploaded) ok++;
				else console.warn('[AI桥接] 图片' + ok + '粘贴后未见预览，可能未登录或上传失败');
			} catch (e) {
				console.warn('[AI桥接] 图片粘贴失败:', e);
			}
		}
		return ok > 0;
	}
};

/* ------------------------------------------------------------------ */
/*  智谱清言适配器（chatglm.cn）— 未实测                                 */
/* ------------------------------------------------------------------ */

const ChatGLMAdapter: SiteAdapter = {
	siteId: 'chatglm',
	name: '智谱清言',
	domains: ['chatglm.cn', 'www.chatglm.cn'],

	findInput(): HTMLElement | null {
		return document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
	},

	async inputText(text: string): Promise<boolean> {
		const el = this.findInput();
		if (!el) return false;
		const head = text.slice(0, 20);
		for (let i = 0; i < 3; i++) {
			el.focus();
			if (el instanceof HTMLTextAreaElement) {
				el.value = text;
				el.dispatchEvent(new Event('input', { bubbles: true }));
			} else {
				const dt = new DataTransfer();
				dt.setData('text/plain', text);
				el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
			}
			await $.sleep(500);
			const current = el instanceof HTMLTextAreaElement ? el.value : (el.textContent || '');
			if (current.includes(head)) return true;
			console.warn('[AI桥接] 粘贴第 ' + (i + 1) + ' 次未生效，重试...');
		}
		return false;
	},

	clickSend(): boolean {
		const btns = document.querySelectorAll('button');
		for (const b of Array.from(btns)) {
			const label = b.getAttribute('aria-label') || '';
			const inner = b.textContent || '';
			if ((label.includes('发送') || inner.includes('发送')) && !b.disabled) {
				b.click();
				return true;
			}
		}
		return false;
	},

	async resetInput(): Promise<void> {
		await clearInput(this.findInput());
	},

	async newChat(): Promise<void> {
		const els = Array.from(document.querySelectorAll('div, button'));
		for (const el of els) {
			if (el.textContent?.trim() === '新对话') {
				(el as HTMLElement).click();
				await $.sleep(1500);
				return;
			}
		}
	},

	getResponse(): string | null {
		const sels = ['[class*="assistant"] [class*="content"]', '[class*="markdown"]', '[class*="message-content"]'];
		for (const sel of sels) {
			const els = document.querySelectorAll(sel);
			if (els.length) {
				const text = els[els.length - 1].textContent?.trim();
				if (text) return text;
			}
		}
		return null;
	},

	isGenerating(): boolean {
		return !!document.querySelector('button[class*="stop"], [class*="loading"], [class*="typing"]');
	},

	uploadImages: genericUploadImages
};

/* ------------------------------------------------------------------ */
/*  适配器注册表                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  扣子适配器（coze.cn）— CodeMirror 6 编辑器                          */
/* ------------------------------------------------------------------ */

/** 扣子统一使用的模型（用户指定） */
const COZE_MODEL = 'Deepseek-V4-Flash';

/**
 * 清空输入框（重发前用）。绝不跳转页面 —— 跳转会销毁 JS 上下文，答案写不回去。
 * 兼容 contenteditable（千问/扣子）与 textarea（DeepSeek）。
 */
async function clearInput(el: HTMLElement | null): Promise<void> {
	if (!el) return;
	try {
		(el as HTMLElement).focus();
		const anyEl = el as any;
		if (anyEl.isContentEditable) {
			const sel = window.getSelection();
			if (sel) {
				const r = document.createRange();
				r.selectNodeContents(el);
				sel.removeAllRanges();
				sel.addRange(r);
				document.execCommand && document.execCommand('delete');
			}
			// 兜底：直接清空 DOM
			if ((el.textContent || '').trim()) el.textContent = '';
		} else if ('value' in anyEl) {
			anyEl.value = '';
			anyEl.dispatchEvent(new Event('input', { bubbles: true }));
		}
		await $.sleep(200);
	} catch (e) {
		console.warn('[AI桥接] 清空输入框失败:', String(e));
	}
}

/**
 * Radix popper 菜单项点击：合成 click 打不开（实测），必须完整指针事件序列；
 * 有 CDP 守护进程时优先真实点击（isTrusted=true）。
 */
async function radixClick(el: HTMLElement): Promise<boolean> {
	if (await trustedClick(el)) return true;
	try {
		const r = el.getBoundingClientRect();
		const x = r.left + r.width / 2;
		const y = r.top + r.height / 2;
		const init: any = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1 };
		el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
		el.dispatchEvent(new MouseEvent('mousedown', init));
		el.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
		el.dispatchEvent(new MouseEvent('mouseup', init));
		el.dispatchEvent(new MouseEvent('click', init));
		return true;
	} catch {
		return false;
	}
}

/** 找输入框下方的模型选择按钮（文本形如 Deepseek-V4-Flash / Auto / GLM-5.3-Flash） */
function findCozeModelButton(): HTMLElement | null {
	const re = /^(auto|glm-|kimi|deepseek|doubao|qwen|minimax)/i;
	const hits = Array.from(document.querySelectorAll<HTMLElement>('button')).filter(
		(b) => b.offsetParent !== null && re.test((b.innerText || '').trim())
	);
	return hits.length ? hits[hits.length - 1] : null;
}

/**
 * 确保扣子当前模型是 {@link COZE_MODEL}（幂等：已是目标模型时零开销直接返回）
 * 每次发题前调用，防止新建对话/换 agent 后被打回 Auto。
 */
async function ensureCozeModel(): Promise<boolean> {
	const btn = findCozeModelButton();
	if (!btn) return false;
	if (new RegExp(COZE_MODEL, 'i').test(btn.innerText || '')) return true;

	console.log('[AI桥接] 扣子模型不是 ' + COZE_MODEL + '，自动切换…');
	await radixClick(btn);
	await $.sleep(900);

	const menu = document.querySelector('[role="menu"]');
	if (!menu) {
		console.warn('[AI桥接] 扣子模型菜单未打开，跳过切换');
		return false;
	}

	const pick = () => {
		const items = Array.from(menu.querySelectorAll<HTMLElement>('[class*="select"]'));
		return items.find((e) => new RegExp(COZE_MODEL, 'i').test(e.innerText || '')) || null;
	};

	let target = pick();
	if (!target) {
		// 目标在「语言模型」tab 下，当前可能在别的 tab
		const tab = Array.from(menu.querySelectorAll<HTMLElement>('[role="tab"], button')).find(
			(e) => (e.innerText || '').trim() === '语言模型'
		);
		if (tab) {
			await radixClick(tab);
			await $.sleep(500);
			target = pick();
		}
	}

	if (!target) {
		console.warn('[AI桥接] 扣子模型菜单里没找到 ' + COZE_MODEL);
		document.body.click();
		return false;
	}

	await radixClick(target);
	await $.sleep(700);
	const ok = new RegExp(COZE_MODEL, 'i').test(findCozeModelButton()?.innerText || '');
	console.log('[AI桥接] 扣子模型切换' + (ok ? '成功：' + COZE_MODEL : '可能失败'));
	return ok;
}

const CozeAdapter: SiteAdapter = {
	siteId: 'coze',
	name: '扣子',
	domains: ['coze.cn'],

	findInput(): HTMLElement | null {
		return document.querySelector('.cm-content') as HTMLElement | null;
	},

	/**
	 * CodeMirror 6：直接改 DOM 无效（内部维护文档模型，会覆盖回去），
	 * 必须拿 EditorView 实例走 dispatch。实测 `.cm-content` 上挂着 `cmView.view`。
	 */
	async inputText(text: string): Promise<boolean> {
		// 每次发题前确保模型是 DeepSeek-V4-Flash（幂等：已是目标模型时零开销返回）
		await ensureCozeModel().catch(() => {});
		const el = this.findInput();
		if (!el) return false;
		const view = (el as any).cmView && (el as any).cmView.view;
		if (!view || !view.state || !view.state.doc) return false;
		try {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
			await $.sleep(300);
			const ok = String(view.state.doc.toString()).includes(text.slice(0, 20));
			if (!ok) console.warn('[AI桥接] 扣子编辑器写入未生效');
			return ok;
		} catch (e) {
			console.warn('[AI桥接] 扣子编辑器写入异常:', String(e));
			return false;
		}
	},

	clickSend(): boolean {
		// 实测两个 aria-label：新建任务页 = 提交新任务；会话页 = 发送消息
		const btn = document.querySelector(
			'[aria-label="发送消息"], [aria-label="提交新任务"]'
		) as HTMLButtonElement | null;
		if (!btn || btn.disabled) return false;
		trustedClickFire(btn);
		return true;
	},

	/** 清空扣子输入框：全选后删除。绝不跳转页面。 */
	async resetInput(): Promise<void> {
		await clearInput(this.findInput());
	},

	async newChat(): Promise<void> {
		const btn = document.querySelector('[aria-label="新任务"]') as HTMLElement | null;
		if (btn) {
			btn.click();
			await $.sleep(1800);
			await ensureCozeModel().catch(() => {});
			return;
		}
		location.href = 'https://www.coze.cn/new-task';
		await $.sleep(1500);
		await ensureCozeModel().catch(() => {});
	},

	getResponse(): string | null {
		// 每条 AI 回答新建一个 .flow-markdown-body（实测 1→2），取最后一个
		const bodies = document.querySelectorAll('.flow-markdown-body');
		if (!bodies.length) return null;
		const t = ((bodies[bodies.length - 1] as HTMLElement).innerText || '').trim();
		return t || null;
	},

	/**
	 * 扣子没有「停止生成」按钮（实测 stop=0），生成中发送按钮 disabled，
	 * 但输入框为空时同样 disabled，无法区分 → 交给 waitForResponse 的文本变化判定
	 */
	isGenerating(): boolean {
		return false;
	},

	/** 附件：composer 里有个 hidden input[type=file]（新页面可能还没渲染，等几秒） */
	async uploadImages(images: string[]): Promise<boolean> {
		// 优先 CDP 真实上传；JS 赋值只会出预览、服务端收不到（扣子实测）
		if (await cdpUploadImages(images)) return true;

		let input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
		for (let i = 0; !input && i < 6; i++) {
			await $.sleep(500);
			input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
		}
		if (!input) return false;
		try {
			const dt = new DataTransfer();
			for (let i = 0; i < images.length; i++) {
				const blob = await (await fetch(images[i])).blob();
				dt.items.add(new File([blob], `q_${i}.png`, { type: blob.type || 'image/png' }));
			}
			input.files = dt.files;
			input.dispatchEvent(new Event('change', { bubbles: true }));
			// 附件只是本地预览，上传到服务器要更久；等不够就发送，AI 会收到一条没有附件的消息
			// （实测 2.5 秒时发送，AI 回「请提供图片」；5 秒后发送正常）
			await $.sleep(5000);
			return true;
		} catch (e) {
			console.warn('[AI桥接] 扣子图片上传失败:', String(e));
			return false;
		}
	},

	/**
	 * 图片题发送：把「提示词图 + 题图」作为附件一次性上传，再写入真文字。
	 * 数据处理与千问一致（提示词也渲染成图），只是发送手段不同——
	 * 千问走 ClipboardEvent 粘贴，扣子走隐藏 file input 上传。
	 */
	async inputWithImages(text: string, images: string[]): Promise<boolean> {
		const ok = await this.uploadImages!(images);
		if (!ok) return false;
		// 扣子处理图片要 3 秒以上才激活发送按钮，等它一下，避免 clickSend 时还 disabled
		const btn = document.querySelector('[aria-label="提交新任务"], [aria-label="发送消息"]') as HTMLButtonElement | null;
		if (btn && btn.disabled) {
			for (let i = 0; i < 15 && btn.disabled; i++) await $.sleep(300);
		}
		return await this.inputText(text);
	}
};

/* ------------------------------------------------------------------ */
/*  DeepSeek 适配器（chat.deepseek.com）— 原生 textarea                 */
/* ------------------------------------------------------------------ */

const DeepSeekAdapter: SiteAdapter = {
	siteId: 'deepseek',
	name: 'DeepSeek',
	domains: ['deepseek.com'],

	findInput(): HTMLElement | null {
		return document.querySelector('textarea') as HTMLElement | null;
	},

	/** React 受控 textarea：直接改 value 不生效，必须原生 setter + input 事件 */
	async inputText(text: string): Promise<boolean> {
		const ta = document.querySelector('textarea') as HTMLTextAreaElement | null;
		if (!ta) return false;
		ta.focus();
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
		if (setter) setter.call(ta, text);
		else ta.value = text;
		ta.dispatchEvent(new Event('input', { bubbles: true }));
		await $.sleep(300);
		return ta.value.includes(text.slice(0, 20));
	},

	/** 发送按钮是 textarea 右侧最远的 ds-button--primary（DIV，无 aria-label，只能按位置认） */
	clickSend(): boolean {
		const ta = document.querySelector('textarea');
		if (!ta) return false;
		const tr = ta.getBoundingClientRect();
		const hit = Array.from(document.querySelectorAll<HTMLElement>('[class*="ds-button--primary"]'))
			.filter((e) => {
				if (!e.offsetParent) return false;
				const r = e.getBoundingClientRect();
				return r.left > tr.left && Math.abs(r.top - tr.top) < tr.height + 60;
			})
			.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
		if (!hit) return false;
		trustedClickFire(hit);
		return true;
	},

	async resetInput(): Promise<void> {
		await clearInput(this.findInput());
	},

	async newChat(): Promise<void> {
		const hit = Array.from(document.querySelectorAll<HTMLElement>('div, button, a')).find(
			(e) => (e.innerText || '').trim() === '开启新对话' && e.offsetParent
		);
		if (hit) {
			hit.click();
			await $.sleep(1200);
			return;
		}
		location.href = 'https://chat.deepseek.com/';
		await $.sleep(1200);
	},

	getResponse(): string | null {
		// 回答容器：ds-markdown（实测发送后 URL 变为 /a/chat/s/xxx，SPA 路由不整页跳转）
		const els = Array.from(document.querySelectorAll<HTMLElement>('[class*="ds-markdown"]')).filter(
			(e) => e.offsetParent
		);
		if (!els.length) return null;
		const t = (els[els.length - 1].innerText || '').trim();
		return t || null;
	},

	/** 生成中会出现「停止生成」按钮（结束即消失） */
	isGenerating(): boolean {
		const el = document.querySelector('[aria-label*="停止"]') as HTMLElement | null;
		return !!el && el.offsetParent !== null;
	},

	uploadImages: genericUploadImages,

	/**
	 * 图片题发送：把「提示词图 + 题图」作为附件上传，再写入真文字。
	 * 数据处理与千问一致（提示词也渲染成图），只是发送手段不同：
	 * 千问走 ClipboardEvent 粘贴，DeepSeek 走 file input 上传。
	 */
	async inputWithImages(text: string, images: string[]): Promise<boolean> {
		const ok = await genericUploadImages(images);
		if (!ok) return false;
		return await this.inputText(text);
	}
};

export const ADAPTERS: SiteAdapter[] = [QwenAdapter, ChatGLMAdapter, CozeAdapter, DeepSeekAdapter];

/** 根据当前页面域名获取适配器 */
function getAdapterForCurrentPage(): SiteAdapter | null {
	const host = location.hostname;
	for (const adapter of ADAPTERS) {
		if (adapter.domains.some((d) => host.includes(d))) return adapter;
	}
	return null;
}

/* ------------------------------------------------------------------ */
/*  桥接逻辑                                                            */
/* ------------------------------------------------------------------ */

/** 对话复用上限：一个对话问满 100 题才废弃换新，否则一直复用——包括页面刷新后
 *  （使用计数按对话 URL 持久化在 GM 存储，重载不重置、不再每次加载都新建对话）。
 *  注：快速连问约 20 题可能触发千问空回答限流，正常刷题节奏下 100 题够用；
 *  若实际出现空回答超时，可调小此值 */
const CHAT_QUESTIONS_CAP = 100;

/** 对话使用计数（GM 存储）：{ [对话URL]: 已问数 }。
 *  按会话 URL 记录——多个千问标签页各在自己对话里计数，互不覆盖 */
const BRIDGE_CHAT_USE_KEY = 'ai_bridge_chat_use';

function readChatUseMap(): Record<string, number> {
	try { return JSON.parse(String(GM_getValue(BRIDGE_CHAT_USE_KEY, '')) || '{}') || {}; } catch { return {}; }
}

function getChatUse(): { url: string; count: number } {
	const map = readChatUseMap();
	const count = map[location.href];
	return { url: location.href, count: typeof count === 'number' ? count : 0 };
}

function setChatUse(count: number): void {
	try {
		const map = readChatUseMap();
		map[location.href] = count;
		GM_setValue(BRIDGE_CHAT_USE_KEY, JSON.stringify(map));
	} catch {}
}

/** 待处理问题队列（GM 存储）：id → 问题。发题端入队并"敲门"，空闲标签页认领 */
const BRIDGE_QUEUE_KEY = 'ai_bridge_queue';
const BRIDGE_KNOCK_KEY = 'ai_bridge_knock';

/** 本标签页忙标记：一个标签页只有一个可见对话，同一时间只处理一题 */
let busy = false;

/** 跨导航续接：首页发首条消息后千问会跳转到对话URL并杀死本页的等待循环，
 *  发送前把待完成的题目写入 GM 存储，新页面加载时续接等待回答 */
const BRIDGE_PENDING_KEY = 'ai_bridge_pending';

type BridgePending = {
	id: string;
	text: string;
	timestamp: number;
};

/** 标签页身份：多标签页时按此认领问题 */
const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

function isVisible(el: Element): boolean {
	const html = el as HTMLElement;
	if (typeof html.getBoundingClientRect !== 'function') return false;
	const rect = html.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}

/**
 * 把提示词文字渲染成图片（canvas 排版，中英文自动换行）
 *
 * 千问编辑器在"图+文同贴"时会把文字静默丢弃（实测：发出的消息里文本为空），
 * 因此带图的题目必须把完整提示词（题目/选项说明/作答要求）画进一张图，
 * 作为第一张图粘贴，AI 才能看见题目文字。
 */
function renderTextToImage(text: string): string | null {
	try {
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');
		if (!ctx || !text) return null;
		const width = 820;
		const fontSize = 26;
		const lineHeight = 40;
		const pad = 24;
		ctx.font = `${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;

		// 逐字符换行（中文任意字符可断行；连续的英文/数字尽量不拆）
		const wrapLine = (line: string): string[] => {
			const out: string[] = [];
			let cur = '';
			let run = ''; // 当前不可拆的连续拉丁/数字段
			const flushRun = () => {
				cur += run;
				run = '';
			};
			for (const ch of line) {
				if (/[A-Za-z0-9.,%°\-+*/=<>()（）\[\]{}]/.test(ch)) {
					run += ch;
					// 拉丁段超宽也要硬拆
					if (ctx.measureText(cur + run).width > width - pad * 2) {
						out.push(cur);
						cur = '';
					}
				} else {
					flushRun();
					if (ctx.measureText(cur + ch).width > width - pad * 2) {
						out.push(cur);
						cur = ch;
					} else {
						cur += ch;
					}
				}
			}
			flushRun();
			if (cur) out.push(cur);
			return out.length ? out : [''];
		};

		const allLines: string[] = [];
		for (const raw of text.split('\n')) {
			allLines.push(...wrapLine(raw));
		}
		const height = Math.min(allLines.length * lineHeight + pad * 2, 4000);
		canvas.width = width;
		canvas.height = height;
		// 重新设置（改尺寸会重置 ctx 状态）
		const c2 = canvas.getContext('2d')!;
		c2.fillStyle = '#ffffff';
		c2.fillRect(0, 0, width, height);
		c2.fillStyle = '#1a1a1a';
		c2.font = `${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
		c2.textBaseline = 'top';
		allLines.slice(0, Math.floor((height - pad * 2) / lineHeight)).forEach((l, i) => {
			c2.fillText(l, pad, pad + i * lineHeight);
		});
		return canvas.toDataURL('image/png');
	} catch (e) {
		return null;
	}
}

/**
 * 检测页面是否弹出了滑块验证码
 *
 * 只识别"可见的"验证码组件（iframe / 验证码容器 / 精确提示文案）。
 * 不能全文匹配 body 文本：题目和 AI 回答里常出现"滑块"（物理题）等词，会误报。
 */
function hasCaptcha(): boolean {
	// 验证码 iframe（阿里云等）
	for (const f of Array.from(document.querySelectorAll('iframe[src*="captcha"]'))) {
		if (isVisible(f)) return true;
	}
	// 可见的验证码容器（nc_ 为阿里云 NoCaptcha，slide/slider-verify 为滑块组件）
	const selectors = [
		'[class*="nc_container"]', '[class*="nc-container"]',
		'[class*="slide-verify"]', '[class*="slider-verify"]', '[class*="slider-captcha"]'
	];
	for (const sel of selectors) {
		for (const el of Array.from(document.querySelectorAll(sel))) {
			if (isVisible(el)) return true;
		}
	}
	// 精确提示文案：叶子元素全文恰好是验证码提示（而非"包含"）
	for (const el of Array.from(document.querySelectorAll('div, span, p'))) {
		if (!isVisible(el)) continue;
		const t = (el.textContent || '').trim();
		if (el.children.length === 0 && (t === '完成验证' || t === '拖动到最右边' || t === '请拖动滑块完成验证')) {
			return true;
		}
	}
	return false;
}

/**
 * 自动解决滑块验证码
 * 原理：找到滑块按钮和轨道，模拟真人鼠标事件序列（mousedown → 多次 mousemove → mouseup）
 */
async function solveSliderCaptcha(): Promise<boolean> {
	// 等待验证码渲染完成
	await $.sleep(1000);

	// 策略1：找文本提示"拖动到最右边"附近的按钮
	const hint = Array.from(document.querySelectorAll('*')).find((el) => {
		const t = el.childNodes.length === 1 && el.textContent?.includes('拖动到最右边');
		return t && el.getBoundingClientRect().width > 0;
	});

	let sliderBtn: HTMLElement | null = null;
	let track: HTMLElement | null = null;

	if (hint) {
		// 提示文字所在的就是轨道，找里面的可拖动按钮
		track = (hint as HTMLElement).closest('div[class]') || (hint as HTMLElement).parentElement;
		if (track) {
			// 按钮通常是轨道内最小的可点击元素（含图标或文字）
			const btns = track.querySelectorAll('button, [class*="btn"], [class*="icon"], [class*="handle"], span, div');
			for (const b of Array.from(btns)) {
				const r = (b as HTMLElement).getBoundingClientRect();
				// 滑块按钮特征：小方块，宽高 25-60px，在轨道左端
				if (r.width >= 25 && r.width <= 70 && r.height >= 25 && r.height <= 70 && r.width < track.getBoundingClientRect().width / 3) {
					sliderBtn = b as HTMLElement;
					break;
				}
			}
		}
	}

	// 策略2：全局找按钮，条件同上
	if (!sliderBtn || !track) {
		const allBtns = document.querySelectorAll('button, [class*="slider"] [class*="btn"], [class*="handle"]');
		for (const b of Array.from(allBtns)) {
			const el = b as HTMLElement;
			const r = el.getBoundingClientRect();
			if (r.width >= 25 && r.width <= 70 && r.height >= 25 && r.height <= 70) {
				const parent = el.parentElement;
				if (parent) {
					const pr = parent.getBoundingClientRect();
					// 父级比按钮宽 3 倍以上且高度不大 → 像轨道
					if (pr.width > r.width * 3 && pr.height < 100) {
						sliderBtn = el;
						track = parent;
						break;
					}
				}
			}
		}
	}

	if (!sliderBtn || !track) return false;

	const btnRect = sliderBtn.getBoundingClientRect();
	const trackRect = track.getBoundingClientRect();
	const startX = btnRect.x + btnRect.width / 2;
	const startY = btnRect.y + btnRect.height / 2;
	const endX = trackRect.x + trackRect.width - btnRect.width / 2;
	const distance = endX - startX;

	if (distance < 50) return false;

	// 模拟真人拖动（带随机加速度和 y 轴抖动）
	sliderBtn.dispatchEvent(new MouseEvent('mousedown', {
		button: 0, bubbles: true, cancelable: true,
		clientX: startX, clientY: startY, buttons: 1
	}));

	const steps = 15 + Math.floor(Math.random() * 8);
	for (let i = 1; i <= steps; i++) {
		await $.sleep(30 + Math.random() * 40);
		const progress = i / steps;
		// 先快后慢（模拟真人）
		const eased = 1 - Math.pow(1 - progress, 1.5);
		const x = startX + distance * eased;
		const y = startY + Math.sin(i * 2) * 1.5;
		sliderBtn.dispatchEvent(new MouseEvent('mousemove', {
			button: 0, bubbles: true, cancelable: true,
			clientX: x, clientY: y, buttons: 1
		}));
	}

	await $.sleep(100);
	sliderBtn.dispatchEvent(new MouseEvent('mouseup', {
		button: 0, bubbles: true, cancelable: true,
		clientX: endX, clientY: startY, buttons: 0
	}));

	await $.sleep(1500);
	return !hasCaptcha();
}

/** 桥接进度回报：写到 <html data-ocs-bridge> 属性（跨隔离环境可观测） */
function bridgeStatus(phase: string, info?: string): void {
	try {
		document.documentElement.setAttribute('data-ocs-bridge', JSON.stringify({ phase, info: (info || '').substring(0, 500), ts: Date.now() }));
	} catch {}
}

/**
 * 轻度随机化消息文本，降低固定消息指纹（千问风控可见消息内容）。
 * 只动开头引导语和结尾礼貌语，核心指令（题型/最终答案格式）保持不变。
 */
function humanizePrompt(text: string): string {
	let t = text;
	const openers = ['本题的问题是：', '题目是：', '题干：', '问题：'];
	for (const op of openers) {
		if (t.startsWith(op)) {
			t = openers[Math.floor(Math.random() * openers.length)] + t.slice(op.length);
			break;
		}
	}
	const tails = ['', '', '', '请仔细分析后作答。', '请认真作答。'];
	const tail = tails[Math.floor(Math.random() * tails.length)];
	if (tail) t += '\n' + tail;
	return t;
}

async function processQuestion(qRaw: BridgeQuestion, adapter: SiteAdapter): Promise<void> {
	// 消息轻度随机化（开头引导语/结尾礼貌语），降低固定指纹
	const q: BridgeQuestion = { ...qRaw, text: humanizePrompt(qRaw.text) };
	const answer: BridgeAnswer = { id: q.id, answer: '', timestamp: Date.now() };

	try {
		bridgeStatus('start', q.text.substring(0, 80));

		// 无响应自动重发（2026-10-18 根治）：
		// 旧逻辑第一次失败就调 adapter.newChat()，而扣子的 newChat 会 location.href 整页跳转 ——
		// 页面一跳转，本页 JS 上下文连同这个 Promise 链一起被销毁：
		//   · 答案永远写不回 ai_bridge_answer_<key>
		//   · 发题端 90 秒超时后报"搜索不到答案"，直接跳过该题
		//   · 新页面重新 onstart 后 busy 状态丢失，看起来就是"AI 页再也不问问题了"
		// 新规则：只在这两个条件都满足时才重发，且重发绝不触发页面跳转。
		//   1) 当前页面没有发生过导航（URL 没变）
		//   2) 失败原因不是"输入/发送失败"（那种重发也没用）
		const navGuard = location.href;
		const MAX_SEND_ATTEMPTS = 2;
		let response = '';
		for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS && !response; attempt++) {
			if (attempt > 1) {
				// 页面已经跳走 → 上下文已毁，任何重试都无意义，直接失败让发题端知道
				if (location.href !== navGuard) {
					throw new Error('页面已跳转，无法在本页完成重发');
				}
				bridgeStatus('retry-new-chat');
				console.log('[AI桥接] 上次无响应/失败，重发（第' + attempt + '次尝试，不切换对话以免页面跳转）');
				try { GM_deleteValue(BRIDGE_PENDING_KEY); } catch {}
				await adapter.resetInput();
				setChatUse(getChatUse().count);
			}

			// 0. 检查验证码，有则自动尝试解决
			if (hasCaptcha()) {
				bridgeStatus('captcha-detected');
				console.log('[AI桥接] 检测到滑块验证码，尝试自动解决...');
				const solved = await solveSliderCaptcha();
				if (!solved) {
					throw new Error('验证码自动解决失败，请手动完成后重试');
				}
				console.log('[AI桥接] 验证码已通过');
			}

			// 1. 对话复用：当前对话问满 CHAT_QUESTIONS_CAP 题才废弃换新，否则复用（含刷新后）
			const use = getChatUse();
			if (use.count >= CHAT_QUESTIONS_CAP) {
				bridgeStatus('new-chat', '第' + (use.count + 1) + '题，对话已达上限' + CHAT_QUESTIONS_CAP + '，换新对话');
				console.log('[AI桥接] 对话已问 ' + use.count + ' 题（上限 ' + CHAT_QUESTIONS_CAP + '），新建对话');
				await adapter.newChat();
				setChatUse(0);
				// 内存治理：废弃对话的 DOM（图片缩略图+公式渲染）只增不删，
				// 通知 CDP 守护进程把本标签整页刷新到新对话，旧 DOM 随导航彻底丢弃
				try {
					const topAny: any = window.top;
					if (topAny && topAny.__cdpDaemon) {
						topAny.__recycleTab = Date.now();
						console.log('[AI桥接] 已请求守护进程回收标签页内存');
					}
				} catch {}
			} else {
				setChatUse(use.count); // 对齐当前 URL（对话切换/跳转后重新计数）
			}

			// 2+3. 输入：有图片时图文一次性粘贴（分开粘贴会导致消息损坏，AI 不响应）；
			//        无图片时走 uploadImages + inputText 常规路径
			//        ⚠️ 实测（2026-09-21）：千问编辑器在"图+文同贴"时会把文字静默丢弃，
			//        AI 只收到图片、从没见过题目文字（判断题正常因为纯文字走 inputText）。
			//        对策：把完整提示词渲染成一张图片，作为第一张图一起粘贴。
			if (q.images && q.images.length && adapter.inputWithImages) {
				// 提示词统一渲染成图片，作为第一张图发送（和千问一致）。
				// 千问还必须这样——它的编辑器会丢粘贴的 text/plain；其余站点不丢，
				// 但为了统一数据处理方式，图片题一律走「提示词图 + 题图」。
				const usePromptImage = adapter.needsPromptAsImage !== false;
				const promptImg = usePromptImage ? renderTextToImage(q.text) : null;
				const images = promptImg ? [promptImg, ...q.images] : q.images;
				bridgeStatus('input-with-images', images.length + '张');
				console.log(
					'[AI桥接] 图片题：提示词已渲染成图片，与题图一起发送（' +
						images.length + ' 张）' +
						(promptImg ? '' : '，当前站点已关闭该选项')
				);
				// 真文字也一起发：千问会丢弃它（无害），其余站点能收到，双通道更稳
				const ok = await adapter.inputWithImages(q.text, images);
				if (!ok) throw new Error('图文粘贴失败（图片未上传，请确认已登录）');
			} else {
				if (q.images && q.images.length && adapter.uploadImages) {
					bridgeStatus('upload-images', q.images.length + '张');
					const ok = await adapter.uploadImages(q.images);
					if (!ok) console.warn('[AI桥接] 图片上传失败，继续发送文字');
				}
				bridgeStatus('input');
				const typed = await adapter.inputText(q.text);
				if (!typed) throw new Error('文字输入失败（找不到输入框或粘贴未生效）');
			}

			// 4. 发送（先记录发送前的旧回答，用于识别新回答）
			const prevResponse = adapter.getResponse() || '';
			await $.sleep(300);
			bridgeStatus('send');
			// 发送前写入跨导航标记：若页面跳转（首页发首条消息会跳到对话URL），新页面续接等待
			const pending: BridgePending = { id: q.id, text: q.text, timestamp: Date.now() };
			try { GM_setValue(BRIDGE_PENDING_KEY, JSON.stringify(pending)); } catch {}
			if (!adapter.clickSend()) {
				try { GM_deleteValue(BRIDGE_PENDING_KEY); } catch {}
				throw new Error('找不到发送按钮或按钮未激活');
			}

			// 5. 等待回答（页面若跳转，本循环死亡，由新页面的续接逻辑完成）
			try {
				bridgeStatus('waiting');
				// 总超时 2 分钟（必须大于「未开始」的 60 秒阈值，否则该判定永远不会触发）
				const r = await waitForResponse(adapter, prevResponse, 120000);
				if (!r) throw new Error('AI 没有返回内容');
				// 发送后校验：图片题若回答"没收到附件"，说明上传没真正生效，交给上层重试
				if (q.images && q.images.length && isAttachmentMissing(r)) {
					throw new Error('AI 未收到附件（上传未生效）：' + r.slice(0, 40));
				}
				response = r;
				try { GM_deleteValue(BRIDGE_PENDING_KEY); } catch {}
			} catch (e) {
				// 首次尝试失败：换新对话重试；已是最后一次则抛出
				if (attempt >= MAX_SEND_ATTEMPTS) throw e;
			}
		}

		// 6. 再次检查验证码（发送后可能触发）
		if (hasCaptcha()) {
			bridgeStatus('captcha-after-send');
			console.log('[AI桥接] 发送后触发验证码，尝试自动解决...');
			const solved = await solveSliderCaptcha();
			if (!solved) {
				throw new Error('回答被验证码拦截且自动解决失败，请手动处理');
			}
		}

		// 根治「重复发送」：
		// waitForResponse 超时时是 return ''（正常返回，不抛异常）。旧代码把它当成功，
		// 写出空答案并标记 done → 发题端解析不出答案 → 90s 后报"搜索不到答案" →
		// worker 重试同一题 → 又发一遍（实测同一题被发 2~4 次）。
		// 现在：空答案一律按失败处理，让发题端立刻拿到 error，不再傻等超时。
		if (!response || !response.trim()) {
			throw new Error('AI 未返回有效内容（等待超时或回答为空）');
		}
		answer.answer = response;
		bridgeStatus('done', response.substring(0, 200));
		// 成功消耗一个对话名额（失败不计数，题目没真正占用对话）
		setChatUse(getChatUse().count + 1);
	} catch (e: any) {
		answer.error = e.message || String(e);
		bridgeStatus('error', answer.error);
	}

	answer.timestamp = Date.now();
	// 按题写答案（支持多题并发，发题端按自己的 id 取）
	try { GM_setValue('ai_bridge_answer_' + q.id, JSON.stringify(answer)); } catch {}
	// 兼容旧单键：监控工具（trigger-watch 等）读这个观察最近一题
	try { GM_setValue(BRIDGE_ANSWER_KEY, JSON.stringify(answer)); } catch {}
}

/* ------------------------------------------------------------------ */
/*  脚本定义                                                            */
/* ------------------------------------------------------------------ */

export const AIBridgeProject = Project.create({
	name: 'AI 桥接',
	domains: ['qianwen.com', 'tongyi.com', 'chatglm.cn', 'coze.cn', 'deepseek.com'],
	scripts: {
		bridge: new Script({
			name: '🔌 AI 答题桥接',
			matches: [
				['千问', /qianwen\.com|tongyi\.com/],
				['智谱清言', /chatglm\.cn/],
				['扣子', /coze\.cn/],
				['DeepSeek', /deepseek\.com/]
			],
			hideInPanel: true,
			onstart() {
				const adapter = getAdapterForCurrentPage();
				// ⚠️ 绝不在这里清空队列！AI 页每次加载/刷新都会跑 onstart，
				// 而答题页可能正在发题 —— 清了就把别人的题丢了：
				// 没人认领 → 发题端 90s 超时 → finish=false → 重新搜题 → 无限重试同一批题。
				// 清理靠「过期」自然完成：claimNext 只认领 2 分钟内的题，
				// 发题端也会在自己的 finally 里删掉自己的队列项。
				console.log('[AI桥接] 已启动 (' + adapter.name + ')，等待答题页面发来问题...');

				// 本页已经发过 AI 的题目指纹（防本页重复发送同一题）
				const seenSubjects = new Set<string>();

			/**
			 * 从队列认领一题处理（2026-10-18 重写版）
			 *
			 * 旧版缺陷：认领标记在 finally 里被删掉，而队列项要等发题端超时才清理，
			 * 处理完一题后 claimNext() 又把同一题扫进来 → 同一题反复发到 AI。
			 *
			 * 新版规则：
			 *   1. 只认领本页未发过的题（seenSubjects 防自己重复发送）
			 *   2. 抢到就立刻从队列删除该项（claim-then-delete）
			 *   3. 无论成功失败都写答案键，发题端立刻拿到结果
			 */
			const claimNext = async (): Promise<void> => {
				if (busy) return;
				await $.sleep(100 + Math.random() * 400); // 多标签页错峰
				let queue: Record<string, any> = {};
				try { queue = JSON.parse(String(GM_getValue(BRIDGE_QUEUE_KEY, '')) || '{}') || {}; } catch {}
				const entries = Object.entries(queue)
					.filter(([, q]) => q && Date.now() - q.timestamp < 120000)
					.sort((a, b) => a[1].timestamp - b[1].timestamp);
				for (const [skey, q] of entries) {
					// 不再按站点过滤：题目该由当前这个 AI 页面认领。
					// 旧的 q.site !== adapter.siteId 过滤，在 site 写错/为空时会让题目永远没人认领。
					if (seenSubjects.has(skey)) continue;
					// 抢占 + 立即从队列移除。
					// ⚠️ 这里必须用 $.sleep（项目封装的 sleep），本文件没有定义裸 sleep——
					//    用错会抛 ReferenceError，而 .catch(() => {}) 会把它吞掉，
					//    表现为「题目从队列消失但没人处理，且之后再也不认领」（busy 卡在 true）。
					// 'gone' = 抢之前队列里就已经没有这一项了（别人先抢走），直接跳过
					let claimed: boolean | 'gone' = false;
					for (let attempt = 0; attempt < 5 && !claimed; attempt++) {
						const cur = JSON.parse(String(GM_getValue(BRIDGE_QUEUE_KEY, '')) || '{}') || {};
						if (!cur[skey]) { claimed = 'gone'; break; }
						const next = {};
						for (const k in cur) { if (k !== skey) next[k] = cur[k]; }
						GM_setValue(BRIDGE_QUEUE_KEY, JSON.stringify(next));
						await $.sleep(120);
						const check = JSON.parse(String(GM_getValue(BRIDGE_QUEUE_KEY, '')) || '{}') || {};
						if (!check[skey]) claimed = true;
					}
					if (claimed !== true) continue;
					seenSubjects.add(skey);
					busy = true;
					console.log('[AI桥接] 认领问题:', q.text.substring(0, 50));
					processQuestion(Object.assign({}, q, { id: skey }), adapter)
						.catch((e) => {
							console.warn('[AI桥接] processQuestion 异常:', e && (e as any).message);
						})
						.finally(() => {
							busy = false;
							claimNext().catch(() => {});
						});
					return;
				}
			};

				// 调试入口：__ocsBridgeTest()（控制台）或 document 派发 'ocs-bridge-test' 事件均可触发
				// 进度通过 <html data-ocs-bridge="..."> 属性回报，跨隔离环境（USER_SCRIPT world）可观测
				try {
					const startTest = (text?: string, images?: string[]) => {
						const q: BridgeQuestion = {
							// 与真实链路一致：用内容指纹做 id，答案键才是 ai_bridge_answer_<指纹>
							id: subjectKey(text || '解答这道单选题\n\n下列哪个是偶数？\nA 1\nB 2\nC 3\nD 5\n\n只输出答案', images || []),
							text: text || '解答这道单选题\n\n下列哪个是偶数？\nA 1\nB 2\nC 3\nD 5\n\n只输出答案',
							images: images || [],
							timestamp: Date.now()
						};
						console.log('[AI桥接] 手动测试开始:', q.text.split('\n')[0]);
						busy = true;
						processQuestion(q, adapter).catch(() => {}).finally(() => { busy = false; });
					};
					const pageWindow: any = (globalThis as any).unsafeWindow || globalThis;
					pageWindow.__ocsBridgeTest = startTest;
					document.addEventListener('ocs-bridge-test', (ev: any) => {
						startTest(ev && ev.detail ? ev.detail.text : undefined, ev && ev.detail ? ev.detail.images : undefined);
					});
					console.log('[AI桥接] 调试提示: 控制台执行 __ocsBridgeTest() 或派发 ocs-bridge-test 事件可测试桥接');
				} catch {}

				// 问题入口：发题端写入队列并敲这个键，值变化唤醒本标签页去认领
				GM_addValueChangeListener(BRIDGE_KNOCK_KEY, (_name, _oldVal, _newVal, remote) => {
					if (!remote) return;
					claimNext().catch(() => {});
				});
				// 启动时扫一遍（敲门可能发生在本页加载前/广播丢失）
				claimNext().catch(() => {});

				// 跨导航续接：上一页面发完消息跳转后，在新页面继续等待回答
				try {
					const rawPending = GM_getValue(BRIDGE_PENDING_KEY, '');
					if (rawPending) {
						const p: BridgePending = JSON.parse(rawPending);
					if (Date.now() - p.timestamp < 120000) {
						console.log('[AI桥接] 续接上一页面的等待:', p.text.substring(0, 30));
						bridgeStatus('waiting-navigated');
						busy = true;
						(async () => {
							// 等页面和回答就绪
							const response = await waitForResponse(adapter, '', 120000);
								try { GM_deleteValue(BRIDGE_PENDING_KEY); } catch {}
								const answer: BridgeAnswer = { id: p.id, answer: response || '', timestamp: Date.now() };
								if (!response) answer.error = '跨导航等待超时，AI 未返回';
								bridgeStatus(response ? 'done' : 'error', (response || answer.error || '').substring(0, 200));
								// 续接的问题同样消耗对话名额
								if (response) setChatUse(getChatUse().count + 1);
								try { GM_setValue('ai_bridge_answer_' + p.id, JSON.stringify(answer)); } catch {}
								try { GM_setValue(BRIDGE_ANSWER_KEY, JSON.stringify(answer)); } catch {}
							})().catch(() => {}).finally(() => {
								busy = false;
								claimNext().catch(() => {});
							});
						} else {
							try { GM_deleteValue(BRIDGE_PENDING_KEY); } catch {}
						}
					}
				} catch {}
			}
		})
	}
});
