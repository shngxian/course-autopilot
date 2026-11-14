/**
 * MUR - Mini Userscript Runtime (service worker) v2 主世界架构
 *
 * v1 教训：USER_SCRIPT 隔离世界无法访问页面主世界变量（unsafeWindow.attachments、
 * top.currentMedia 等 OCS 大量依赖），且无 CustomElementRegistry。
 * v2 方案：脚本直接注册到 MAIN 世界（变量/customElements 全真实可用），
 * GM API 通过 window.postMessage ↔ relay(content script) ↔ chrome.runtime 桥接。
 */

const SCRIPT_URL = 'http://127.0.0.1:18923/ocs.ai.user.js';
const SCRIPT_NS = 'ocs-ai';

/* ---------------- GM 垫片（注入 MAIN 世界，先于用户脚本执行） ---------------- */

const SHIM_TEMPLATE = `
(function () {
	if (window.__MUR_LOADED__) return;
	window.__MUR_LOADED__ = true;
	var NS = '__NS__';
	var NAME = '__NAME__';
	var VERSION = '__VERSION__';
	var cache = {};
	var listeners = {};
	var pending = {};
	var reqId = 0;
	var relayUp = false;

	window.addEventListener('message', function (ev) {
		var msg = ev.data;
		if (!msg || msg.__mur !== 1) return;
		if (msg.type === 'relay-hello') { relayUp = true; return; }
		if (msg.from !== 'relay') return;
		if (msg.type === 'change') { applyChange(msg.key, msg.newVal, true); return; }
		if (msg.rid && pending[msg.rid]) {
			var p = pending[msg.rid];
			delete pending[msg.rid];
			p(msg.err ? { err: msg.err } : msg);
		}
	});

	function send(m) {
		return new Promise(function (res) {
			var id = 'r' + (++reqId);
			m.rid = id;
			pending[id] = res;
			try { window.postMessage({ __mur: 1, m: m, rid: id }, '*'); }
			catch (e) { delete pending[id]; res(null); }
			setTimeout(function () { if (pending[id]) { delete pending[id]; res(null); } }, 60000);
		});
	}

	function waitRelay(timeout) {
		var start = Date.now();
		return new Promise(function (resolve) {
			var ping = setInterval(function () {
				if (relayUp) { clearInterval(ping); resolve(true); return; }
				if (Date.now() - start > timeout) { clearInterval(ping); resolve(false); return; }
				try { window.postMessage({ __mur: 1, type: 'relay-ping' }, '*'); } catch (e) {}
			}, 150);
		});
	}

	function applyChange(k, nv, remote) {
		var had = k in cache;
		var ov = had ? cache[k] : undefined;
		if (nv === undefined || nv === null) { delete cache[k]; } else { cache[k] = nv; }
		(listeners[k] || []).forEach(function (f) { try { f(k, ov, nv, remote); } catch (e) {} });
	}

	var g = window;
	g.GM_info = { script: { name: NAME, version: VERSION }, scriptHandler: 'MUR', version: '2.0.0' };
	g.GM_getValue = function (k, d) { return k in cache ? cache[k] : d; };
	g.GM_setValue = function (k, v) {
		var ov = cache[k];
		cache[k] = v;
		send({ t: 'set', k: k, v: v });
		(listeners[k] || []).forEach(function (f) { try { f(k, ov, v, false); } catch (e) {} });
	};
	g.GM_deleteValue = function (k) { delete cache[k]; send({ t: 'del', k: k }); };
	g.GM_listValues = function () { return Object.keys(cache); };
	g.GM_addValueChangeListener = function (k, f) {
		(listeners[k] = listeners[k] || []).push(f);
		send({ t: 'listen', k: k });
		return k + ':' + (listeners[k].length - 1);
	};
	g.GM_removeValueChangeListener = function () {};
	g.GM_xmlhttpRequest = function (d) {
		send({ t: 'xhr', d: { url: d.url, method: d.method, headers: d.headers, data: d.data, timeout: d.timeout } })
			.then(function (r) {
				try {
					if (!r || r.err) { d.onerror && d.onerror(new Error((r && r.err) || '无传输通道')); }
					else { d.onload && d.onload({ status: r.status, responseText: r.responseText, responseHeaders: r.headers || '', finalUrl: d.url }); }
				} catch (e) {}
			});
	};
	g.GM_setClipboard = function (t) { try { navigator.clipboard.writeText(String(t)); } catch (e) {} };
	g.GM_notification = function (o, c) { try { new Notification(typeof o === 'string' ? o : (o && (o.text || o.title)) || ''); c && c(); } catch (e) {} };
	g.GM_getTab = function (cb) { send({ t: 'gettab' }).then(function (r) { cb && cb((r && r.tab) || {}); }); };
	g.GM_saveTab = function (d) { send({ t: 'savetab', d: d }); };
	g.GM_getResourceText = function () { return ''; };
	// 主世界：unsafeWindow 就是真实的页面 window（OCS 依赖 unsafeWindow.attachments 等）
	g.unsafeWindow = window;

	// 错误上报（调试）
	try {
		var origErr = console.error;
		console.error = function () {
			try {
				var parts = [];
				for (var i = 0; i < arguments.length; i++) {
					var a = arguments[i];
					try { parts.push(typeof a === 'string' ? a : String((a && a.message) || a)); } catch (e2) { parts.push(String(a)); }
				}
				send({ t: 'worldlog', level: 'error', text: parts.join(' ').substring(0, 300) });
			} catch (e) {}
			return origErr.apply(console, arguments);
		};
	} catch (e) {}

	// 嵌套 iframe 注入修复：Chrome137 userScripts 对动态创建的深层 iframe 不注入，
	// 对作业类子 iframe reload 一次触发注入
	try {
		var WORK_IFRAME_RE = /ananas\\/modules\\/work|mooc-ans\\/work|mooc-ans\\/api\\/work|mooc2\\/work/;
		var scanIframes = function () {
			setTimeout(function () {
				try {
					var ifs = document.querySelectorAll('iframe');
					for (var i = 0; i < ifs.length; i++) {
						var f = ifs[i];
						var src = f.src || '';
						if (!WORK_IFRAME_RE.test(src)) continue;
						var key = 'mur_fr_' + src.substring(src.length - 60);
						try { if (sessionStorage.getItem(key)) continue; sessionStorage.setItem(key, '1'); } catch (e2) { continue; }
						try { f.contentWindow.location.reload(); console.log('[MUR] 已重载作业iframe触发注入:', src.substring(src.length - 40)); } catch (e3) {}
					}
				} catch (e) {}
				setTimeout(scanIframes, 3000);
			}, 2500);
		};
		scanIframes();
	} catch (e) {}

	// v2.1 单脚本：等中继 → 拉初始值缓存 → 再启动应用（应用包在本文件尾部的 __MUR_APP__ 函数体内）
	// 根治 v2.0 双注册的执行顺序问题（mur-app 可能先于本垫片执行 → easy-us 拿到 MemoryStore、配置全默认）
	waitRelay(4000).then(function (ok) {
		if (!ok) console.warn('[MUR] 中继未就绪，GM 存储暂不可用');
		return send({ t: 'ready' });
	}).then(function (r) {
		if (r && r.values) {
			for (var k in r.values) {
				if (!(k in cache)) cache[k] = r.values[k];
			}
		}
		window.dispatchEvent(new CustomEvent('__mur-ready'));
		try {
			if (typeof __MUR_APP__ === 'function') __MUR_APP__();
			else console.error('[MUR] __MUR_APP__ 未定义');
		} catch (e) {
			console.error('[MUR] 用户脚本执行错误:', e && e.message);
			try { send({ t: 'worldlog', level: 'error', text: 'app启动失败: ' + ((e && e.stack) || e).substring(0, 300) }); } catch (e4) {}
		}
	});
})();
`;

/* ---------------- 头部解析 ---------------- */

function parseUserscriptHeader(code) {
	const m = code.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
	const meta = { matches: [], name: 'userscript', version: '0.0.0', runAt: 'document_start' };
	if (!m) return meta;
	for (const line of m[1].split('\n')) {
		const km = line.match(/@(\S+)\s+(.+)/);
		if (!km) continue;
		const [, key, val] = km;
		if (key === 'match') meta.matches.push(val.trim());
		if (key === 'name') meta.name = val.trim();
		if (key === 'version') meta.version = val.trim();
		if (key === 'run-at') {
			meta.runAt = val.trim() === 'document-end' ? 'document_end' : val.trim() === 'document-idle' ? 'document_idle' : 'document_start';
		}
	}
	return meta;
}

/* ---------------- 消息处理（经 relay content script 转发） ---------------- */

async function handleOp(m, respond, sender) {
	try {
		if (m.t === 'ready') {
			respond({ values: await getNamespaced(SCRIPT_NS) });
		} else if (m.t === 'set') {
			await chrome.storage.local.set({ [SCRIPT_NS + '::' + m.k]: m.v });
			broadcastChange(SCRIPT_NS, m.k, m.v);
			respond({ ok: true });
		} else if (m.t === 'del') {
			await chrome.storage.local.remove(SCRIPT_NS + '::' + m.k);
			broadcastChange(SCRIPT_NS, m.k, undefined);
			respond({ ok: true });
		} else if (m.t === 'sync') {
			respond({ values: await getNamespaced(SCRIPT_NS) });
		} else if (m.t === 'listen') {
			respond({ ok: true });
		} else if (m.t === 'xhr') {
			const d = m.d || {};
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), Math.min(d.timeout || 90000, 120000));
			try {
				const resp = await fetch(d.url, {
					method: d.method || 'GET',
					headers: d.headers || {},
					body: d.data || undefined,
					signal: ctrl.signal
				});
				const text = await resp.text();
				respond({ status: resp.status, responseText: text, headers: [...resp.headers.entries()].map(([k, v]) => k + ': ' + v).join('\r\n') });
			} catch (e) {
				respond({ err: e.message });
			} finally { clearTimeout(timer); }
		} else if (m.t === 'gettab') {
			respond({ tab: {} });
		} else if (m.t === 'savetab') {
			respond({ ok: true });
		} else if (m.t === 'pagelog' || m.t === 'worldlog') {
			respond({ ok: true });
			try {
				const url = (sender && sender.url) || '';
				fetch('http://127.0.0.1:18923/__mur/log', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ url, level: m.level || 'error', text: m.text || '' })
				}).catch(() => {});
			} catch (e) {}
		} else {
			respond({ err: 'unknown op ' + m.t });
		}
	} catch (e) {
		try { respond({ err: e.message }); } catch (_) {}
	}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || !msg.__mur) return false;
	handleOp(msg.m || {}, sendResponse, sender);
	return true;
});

async function getNamespaced(ns) {
	const all = await chrome.storage.local.get(null);
	const out = {};
	for (const k of Object.keys(all)) {
		if (k.startsWith(ns + '::')) out[k.slice(ns.length + 2)] = all[k];
	}
	return out;
}

function broadcastChange(ns, key, newVal) {
	chrome.tabs.query({}, (tabs) => {
		for (const tab of tabs) {
			chrome.tabs.sendMessage(tab.id, { __mur: 1, ns, type: 'change', key, newVal, remote: true }, () => void chrome.runtime.lastError);
		}
	});
}

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'local') return;
	for (const key of Object.keys(changes)) {
		const idx = key.indexOf('::');
		if (idx < 0) continue;
		broadcastChange(key.slice(0, idx), key.slice(idx + 2), changes[key].newValue);
	}
});

/* ---------------- 启动：配置 world + 拉脚本 + 主世界双注册 ---------------- */

async function install() {
	try {
		await chrome.userScripts.configureWorld({ messaging: true });
	} catch (e) {
		console.warn('[MUR] configureWorld 失败（需开启"允许运行用户脚本"）:', e.message);
		return;
	}

	let code = null;
	try {
		const resp = await fetch(SCRIPT_URL);
		if (resp.ok) {
			code = await resp.text();
			await chrome.storage.local.set({ mur_last_code: code, mur_last_fetch: Date.now() });
			console.log('[MUR] 已拉取脚本', code.length, 'chars');
		}
	} catch (e) {
		console.warn('[MUR] 拉取失败（用缓存）:', e.message);
	}
	if (!code) code = (await chrome.storage.local.get('mur_last_code')).mur_last_code;
	if (!code) { console.error('[MUR] 无脚本可用'); return; }

	const meta = parseUserscriptHeader(code);
	if (!meta.matches.length) meta.matches = ['<all_urls>'];

	const shim = SHIM_TEMPLATE
		.replace(/__NS__/g, SCRIPT_NS)
		.replace(/__NAME__/g, meta.name.replace(/'/g, "\\'"))
		.replace(/__VERSION__/g, meta.version.replace(/'/g, "\\'"));

	// v2.1 单脚本：垫片 + 应用包一体（应用包包裹在 __MUR_APP__ 函数体内，由垫片在配置缓存就绪后调用）
	const codeWithSuffix = code + '\n;globalThis.OCS = (typeof OCS !== "undefined" ? OCS : undefined);globalThis.__ocsBundleLoaded = true;';
	const full = shim + '\n;function __MUR_APP__() {\n' + codeWithSuffix + '\n}';

	try {
		const existing = await chrome.userScripts.getScripts();
		await chrome.userScripts.unregister({ ids: existing.map((s) => s.id) });
		await chrome.userScripts.register([
			{ id: 'mur-app', matches: meta.matches, js: [{ code: full }], world: 'MAIN', runAt: 'document_start', allFrames: true }
		]);
		console.log('[MUR] v2.1 单脚本注册完成:', meta.name, meta.version, '长度:', full.length);
	} catch (e) {
		console.error('[MUR] 注册失败:', e.message);
	}
}

chrome.runtime.onInstalled.addListener(() => install());
chrome.runtime.onStartup.addListener(() => install());
install();
