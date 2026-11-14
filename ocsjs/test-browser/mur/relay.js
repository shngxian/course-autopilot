/**
 * MUR 中继（经典 content script）
 *
 * USER_SCRIPT world 的 chrome.runtime 消息在此 Chrome 版本上无法送达 SW，
 * 但 window 的 message 事件跨隔离世界共享。本中继把 world 的请求转发给 SW，
 * 并把 SW 的推送转回 world。
 */
(function () {
	if (window.__MUR_RELAY__) return;
	window.__MUR_RELAY__ = true;

	// 广播自己的存在（world 侧据此确认通道可用）
	window.postMessage({ __mur: 1, type: 'relay-hello' }, '*');

	// world → SW
	window.addEventListener('message', function (ev) {
		const msg = ev.data;
		if (!msg || msg.__mur !== 1 || msg.from === 'relay') return;
		if (msg.type === 'relay-ping') {
			window.postMessage({ __mur: 1, type: 'relay-hello' }, '*');
			return;
		}
		if (!msg.m || msg.type === 'change') return;
		chrome.runtime.sendMessage({ __mur: 1, m: msg.m }, function (resp) {
			void chrome.runtime.lastError;
			window.postMessage({ __mur: 1, from: 'relay', rid: msg.rid, ...(resp || { err: 'no-response' }) }, '*');
		});
	});

	// SW → world（存储变化推送）
	chrome.runtime.onMessage.addListener(function (msg) {
		if (!msg || !msg.__mur || msg.type !== 'change') return;
		window.postMessage({ __mur: 1, from: 'relay', type: 'change', ns: msg.ns, key: msg.key, newVal: msg.newVal, remote: true }, '*');
	});

	// 页面级错误收集（error 事件跨隔离世界共享）
	window.addEventListener('error', function (ev) {
		if (ev && ev.message) {
			chrome.runtime.sendMessage({ __mur: 1, m: { t: 'pagelog', level: 'error', text: String(ev.message).substring(0, 300) + ' @' + (ev.filename || '').substring(0, 80) + ':' + (ev.lineno || 0) } }, () => void chrome.runtime.lastError);
		}
	}, true);
	window.addEventListener('unhandledrejection', function (ev) {
		var r = ev && ev.reason;
		var text = r && r.message ? r.message : String(r);
		chrome.runtime.sendMessage({ __mur: 1, m: { t: 'pagelog', level: 'error', text: ('UnhandledRejection: ' + text).substring(0, 300) } }, () => void chrome.runtime.lastError);
	});
})();
