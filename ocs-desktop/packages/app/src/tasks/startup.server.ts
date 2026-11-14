import express from 'express';
import { Logger } from '../logger';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { spawn, exec } from 'child_process';
import { getDecryptedRenderData, store } from '../store';
import { getCurrentWebContents, getProjectPath, moveWindowToTop } from '../utils';
import { canOCR, det, ocr } from '../utils/ocr';
import { randomUUID } from 'crypto';
const logger = Logger('server');

export async function startupServer() {
	const app = express();

	store.set('server', {
		port: 15319,
		authToken: randomUUID().replace(/-/g, '')
	});

	app.use((req, res, next) => {
		res.setHeader('Access-Control-Allow-Origin', req.headers.origin || 'unknown');
		res.setHeader('Access-Control-Allow-Credentials', 'true');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, request-id, if-none-match');
		res.setHeader('Access-Control-Allow-Methods', '*');
		if (req.method === 'OPTIONS') {
			res.sendStatus(204);
			return;
		}
		next();
	});
	// 解析 post 数据
	app.use(express.urlencoded({ extended: false, limit: '10mb' }));
	app.use(express.json({ limit: '10mb' }));

	app.get('/state', (req, res) => {
		res.json({
			public: path.join(getProjectPath(), './public'),
			project: getProjectPath()
		});
	});

	app.get('/ocs-global-setting', (req, res) => {
		const render = getDecryptedRenderData();
		res.json(render.setting.ocs);
	});

	/** 获取 browser 数据 */
	app.get('/browser', (req, res) => {
		const render = getDecryptedRenderData();
		// 如果开启了同步配置，就返回，否则返回空对象
		const data = render?.setting?.ocs?.openSync ? render?.setting?.ocs?.store : {};
		res.json(data);
	});

	app.get('/is-browser-config-sync', (req, res) => {
		const render = getDecryptedRenderData();
		res.end(String(render.setting.ocs.openSync));
	});

	/** 脚本操作 */
	app.get('/ocs-script-actions', (req, res) => {
		res.json({ allow: true });
	});

	app.get('/get-actions-key', (req, res) => {
		res.send(store.store.server.authToken);
	});

	/** 获取浏览器信息（供导航页主动获取） */
	app.get('/api/bookmark/browser-info', (req, res) => {
		const uid = req.query.uid as string;
		if (!uid) {
			res.status(400).json({ error: '缺少 uid 参数' });
			return;
		}
		const render = getDecryptedRenderData();
		const root = render?.browser?.root;
		if (!root) {
			res.json(null);
			return;
		}
		// 递归查找浏览器
		function findBrowser(children: any): any {
			for (const key in children) {
				if (Object.prototype.hasOwnProperty.call(children, key)) {
					const entity = children[key];
					if (entity.type === 'browser' && entity.uid === uid) {
						return entity;
					} else if (entity.type === 'folder' && entity.children) {
						const found = findBrowser(entity.children);
						if (found) return found;
					}
				}
			}
			return null;
		}
		const browser = findBrowser(root.children || {});
		if (!browser) {
			res.json(null);
			return;
		}
		res.json({
			uid: browser.uid,
			name: browser.name || '',
			notes: browser.notes || '',
			tags: browser.tags || []
		});
	});

	app.get('/icon', async (req, res) => {
		const iconUrl = req.query.url as string;
		if (!iconUrl) {
			res.status(400).send('Missing url parameter');
			return;
		}
		try {
			const response = await axios.get(iconUrl, {
				responseType: 'arraybuffer',
				timeout: 5000
			});
			const contentType = response.headers['content-type'] || 'image/png';
			res.setHeader('Content-Type', contentType);
			res.setHeader('Cache-Control', 'public, max-age=86400');
			res.send(response.data);
		} catch (err) {
			// 返回 1x1 透明 GIF 作为降级图标
			res.setHeader('Content-Type', 'image/gif');
			res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
		}
	});

	/** 请求转发 */
	app.post('/proxy', async (req, res) => {
		const { method, url, data, headers } = req.body || {};
		axios
			.request({
				method,
				url,
				data,
				headers
			})
			.then(({ data }) => {
				res.send(data);
			})
			.catch((err) => {
				res.send(err);
			});
	});

	app.get(/\/ocs-action_.+/, (req, res) => {
		res.send('正在执行脚本 : ' + req.path + ' 请勿操作。');
	});

	// ocr 验证码破解
	app.post('/ocr', async (req, res) => {
		const base64 = req.body.image?.toString();
		const det_target = req.body.det_target?.toString();
		const det_bg = req.body.det_bg?.toString();

		if (canOCR()) {
			try {
				if (base64) {
					res.json({ canOCR: true, code: await ocr(base64) });
				} else if (det_target && det_bg) {
					res.json({ canOCR: true, det: await det(det_target, det_bg) });
				} else {
					res.send({ error: '参数缺失!' });
				}
			} catch (err) {
				res.json({ canOCR: true, error: err });
			}
		} else {
			res.json({ canOCR: false });
		}
	});

	app.get('/api/bookmark/show-browser-in-app', (req, res) => {
		moveWindowToTop();
		// 显示浏览器文件
		getCurrentWebContents().send('show-browser-in-app', req.query.uid);
	});

	// 提供本地用户脚本（扩展只能拦截 http/https 请求安装脚本）
	app.get('/api/local-userscript', (req, res) => {
		const filePath = req.query.path as string;
		if (filePath && fs.existsSync(filePath)) {
			res.setHeader('Content-Type', 'application/javascript');
			res.sendFile(path.resolve(filePath));
		} else {
			res.status(404).send('File not found');
		}
	});

	// Chat2API 进程管理（用于 AI 答题模式）
	let chat2apiProcess: import('child_process').ChildProcess | null = null;

	app.post('/api/chat2api/start', (req, res) => {
		if (chat2apiProcess) { return res.json({ running: true }); }
		try {
			const cPath = path.join(__dirname, '../../../../../../Chat2API');
			if (!fs.existsSync(cPath)) { return res.json({ ok: false, msg: 'Chat2API 目录不存在' }); }
			let cmd: string | null = null;
			let args: string[] = [];
			const pkg = path.join(cPath, 'dist/win-unpacked/Chat2API.exe');
			if (fs.existsSync(pkg)) { cmd = pkg; args = ['--no-sandbox']; }
			if (!cmd) {
				const eBin = path.join(cPath, 'node_modules/.bin/electron.cmd');
				const oMain = path.join(cPath, 'out/main/index.js');
				if (fs.existsSync(eBin) && fs.existsSync(oMain)) { cmd = 'cmd'; args = ['/c', eBin, '.', '--no-sandbox']; }
			}
			if (!cmd) {
				const eVite = path.join(cPath, 'node_modules/electron-vite/dist/bin/electron-vite.js');
				if (fs.existsSync(eVite)) { cmd = 'node'; args = [eVite, 'dev', '--no-sandbox']; }
			}
			if (cmd) {
				chat2apiProcess = spawn(cmd, args, { cwd: cPath, stdio: 'ignore', detached: true, windowsHide: true });
				chat2apiProcess.unref();
				logger.info('Chat2API 已启动');
				res.json({ ok: true });
			} else {
				res.json({ ok: false, msg: '找不到 Chat2API 启动方式' });
			}
		} catch (e: any) { res.json({ ok: false, msg: e.message }); }
	});

	app.post('/api/chat2api/stop', (req, res) => {
		if (chat2apiProcess) {
			try {
				const pid = chat2apiProcess.pid!;
				exec('taskkill /pid ' + pid + ' /f /t');
				chat2apiProcess = null;
				logger.info('Chat2API 已关闭');
				res.json({ ok: true });
			} catch (e: any) { res.json({ ok: false, msg: e.message }); }
		} else {
			res.json({ ok: false, msg: 'Chat2API 未运行' });
		}
	});

	app.get('/api/chat2api/status', (req, res) => {
		if (chat2apiProcess) { return res.json({ running: true }); }
		axios.get('http://127.0.0.1:8080/health', { timeout: 2000 })
			.then(() => res.json({ running: true }))
			.catch(() => res.json({ running: false }));
	});

	// 静态资源
	app.use(express.static(path.join(getProjectPath(), './public')));

	return new Promise<void>((resolve, reject) => {
		const server = app.listen(store.store.server.port, () => {
			const address = server.address();
			if (address && typeof address === 'object') {
				// 存储本次服务的端口
				logger.info(`OCS服务启动成功 => ${address.port}`);
			}
			resolve();
		});

		// eslint-disable-next-line no-undef
		server.on('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'EADDRINUSE') {
				logger.error(`端口 ${store.store.server.port} 已被占用，服务启动失败`);
			} else {
				logger.error(`OCS服务启动失败: ${err.message}`);
			}
			reject(err);
		});
	});
}
