/** 像素级验证新版角标：1)左侧条白底+红块 2)原图区域与未标注版完全一致（无遮挡） */
const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const qw = browser.contexts()[0].pages().find((p) => /qianwen/.test(p.url()));
	await sleep(1500);
	const r = await qw.evaluate(() => {
		const make = (text) => {
			const c = document.createElement('canvas');
			c.width = 460; c.height = 80;
			const x = c.getContext('2d');
			x.fillStyle = '#fff'; x.fillRect(0, 0, 460, 80);
			x.fillStyle = '#222'; x.font = '30px serif';
			x.fillText(text, 20, 52);
			return c.toDataURL('image/png');
		};
		const load = (d) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = d; });
		return (async () => {
			const orig = await load(make('y = √(x² + 1)'));
			// 新版 drawOptionLabel 逻辑
			const labeled = await (async () => {
				const w = orig.naturalWidth, h = orig.naturalHeight;
				const fontSize = Math.min(96, Math.max(16, Math.round(h * 0.45)));
				const pad = Math.round(fontSize * 0.35);
				const badgeW = fontSize + pad * 2;
				const badgeH = Math.min(h, Math.round(fontSize * 1.25));
				const stripW = Math.round(badgeW + fontSize * 0.3);
				const c = document.createElement('canvas');
				c.width = w + stripW; c.height = h;
				const x = c.getContext('2d');
				x.fillStyle = '#ffffff'; x.fillRect(0, 0, stripW, h);
				x.drawImage(orig, stripW, 0);
				const bx = Math.round((stripW - badgeW) / 2), by = Math.round((h - badgeH) / 2);
				x.fillStyle = '#e53935'; x.fillRect(bx, by, badgeW, badgeH);
				x.fillStyle = '#fff'; x.font = 'bold ' + fontSize + 'px Arial, sans-serif';
				x.textAlign = 'center'; x.textBaseline = 'middle';
				x.fillText('C', bx + badgeW / 2, by + badgeH / 2 + 1);
				return { canvas: c, stripW, w, h };
			})();
			const { canvas, stripW, w, h } = labeled;
			const xd = canvas.getContext('2d');
			// 检查1：原图区域逐像素与未标注版一致
			const a = xd.getImageData(stripW, 0, w, h).data;
			const oc = document.createElement('canvas'); oc.width = w; oc.height = h;
			oc.getContext('2d').drawImage(orig, 0, 0);
			const b = oc.getContext('2d').getImageData(0, 0, w, h).data;
			let diff = 0;
			for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
			// 检查2：左侧条含红色块（e53935 ≈ r229 g57 b53）
			const strip = xd.getImageData(0, 0, stripW, h).data;
			let redPixels = 0, whitePixels = 0;
			for (let i = 0; i < strip.length; i += 4) {
				const [R, G, B] = [strip[i], strip[i + 1], strip[i + 2]];
				if (R > 200 && G < 100 && B < 100) redPixels++;
				else if (R > 240 && G > 240 && B > 240) whitePixels++;
			}
			// 检查3：角标里有白色字母像素（红块内）
			return {
				尺寸: `${canvas.width}x${canvas.height} (原 ${w}x${h} + 左条 ${stripW}px)`,
				原图区域像素差异: diff,
				左侧条红像素: redPixels,
				左侧条白像素: whitePixels,
				左侧条总像素: stripW * h
			};
		})();
	});
	console.log(JSON.stringify(r, null, 1));
	await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
