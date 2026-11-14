/**
 * OBS 人脸识别场景一键配置脚本
 *
 * 使用方法：
 * 1. 先打开 OBS，确保 WebSocket 服务器已启用（工具 → WebSocket 服务器设置）
 * 2. 把视频文件放到项目根目录的 face-videos/ 文件夹里
 * 3. 运行: node scripts/setup-obs-scenes.js
 *
 * 脚本会自动在 OBS 中创建 6 个场景，并添加对应的媒体/图像源
 */

const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const FACE_VIDEOS_DIR = path.join(ROOT_DIR, 'face-videos');
const DEFAULT_PORT = 4455;

// 场景配置
const SCENES = [
	{ name: 'Normal', file: 'normal.mp4', type: 'media', label: '正常学习' },
	{ name: 'Blink', file: 'blink.mp4', type: 'media', label: '眨眼' },
	{ name: 'Nod', file: 'nod.mp4', type: 'media', label: '点头' },
	{ name: 'TurnHead', file: 'turn-head.mp4', type: 'media', label: '转头' },
	{ name: 'OpenMouth', file: 'open-mouth.mp4', type: 'media', label: '张嘴' },
	{ name: 'Photo', file: 'photo.jpg', type: 'image', label: '静态照片' }
];

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

function ask(question) {
	return new Promise((resolve) => {
		rl.question(question, resolve);
	});
}

async function main() {
	console.log('');
	console.log('========================================');
	console.log('   OCS 人脸识别 - OBS 场景自动配置');
	console.log('========================================\n');

	// 1. 检查视频文件
	console.log('[1/4] 检查视频文件...');
	const missing = [];
	for (const scene of SCENES) {
		const filePath = path.join(FACE_VIDEOS_DIR, scene.file);
		if (!fs.existsSync(filePath)) {
			missing.push(scene.file + ' （' + scene.label + '）');
		} else {
			console.log(`   ✅ ${scene.file} (${scene.label})`);
		}
	}

	if (missing.length > 0) {
		console.log('\n⚠️  以下文件未找到，请先放入 face-videos/ 文件夹：');
		for (const f of missing) {
			console.log(`   - ${f}`);
		}
		const ans = await ask('\n继续配置已存在的场景？(y/n): ');
		if (ans.toLowerCase() !== 'y') {
			console.log('已取消');
			process.exit(0);
		}
	} else {
		console.log('   所有文件已就绪 ✅\n');
	}

	// 2. 连接 OBS WebSocket
	console.log('[2/4] 连接 OBS WebSocket...');
	const port = DEFAULT_PORT;
	const password = ''; // 默认无密码

	const ws = await connectOBS(port, password);
	if (!ws) {
		const portAns = await ask('连接失败，是否使用其他端口？(输入端口号，或 n 取消): ');
		if (portAns.toLowerCase() === 'n' || !portAns) {
			console.log('已取消');
			process.exit(0);
		}
		const altPort = parseInt(portAns);
		if (isNaN(altPort)) {
			console.log('端口无效，已取消');
			process.exit(0);
		}
		ws = await connectOBS(altPort, password);
		if (!ws) {
			console.log('连接失败，请确认 OBS 已启动且 WebSocket 服务器已启用。');
			console.log('OBS → 工具 → WebSocket 服务器设置');
			process.exit(1);
		}
	}

	console.log('   已连接到 OBS ✅\n');

	// 3. 创建场景和源
	console.log('[3/4] 创建场景和媒体源...');

	for (const scene of SCENES) {
		const filePath = path.join(FACE_VIDEOS_DIR, scene.file);
		if (!fs.existsSync(filePath)) {
			console.log(`   ⏭️  跳过 ${scene.name}（文件不存在）`);
			continue;
		}

		console.log(`   创建场景: ${scene.name} (${scene.label})`);

		try {
			// 创建场景
			await sendRequest(ws, 'CreateScene', {
				sceneName: scene.name
			});
		} catch (e) {
			// 场景可能已存在
			console.log(`     场景已存在，跳过创建`);
		}

		try {
			if (scene.type === 'media') {
				// 创建媒体源 (ffmpeg_source)
				const sourceName = scene.name + '-Source';
				await sendRequest(ws, 'CreateInput', {
					sceneName: scene.name,
					inputName: sourceName,
					inputKind: 'ffmpeg_source',
					inputSettings: {
						local_file: filePath.replace(/\\/g, '/'),
						looping: true,
						is_local_file: true,
						clear_on_media_end: false,
						restart_on_activate: true
					},
					sceneItemEnabled: true
				});
			} else if (scene.type === 'image') {
				// 创建图像源 (image_source)
				const sourceName = scene.name + '-Source';
				await sendRequest(ws, 'CreateInput', {
					sceneName: scene.name,
					inputName: sourceName,
					inputKind: 'image_source',
					inputSettings: {
						file: filePath.replace(/\\/g, '/')
					},
					sceneItemEnabled: true
				});
			}
			console.log(`     ✅ 源添加成功`);
		} catch (e) {
			console.log(`     ❌ 添加源失败: ${e.message}`);
		}
	}

	console.log('\n[4/4] 配置完成!\n');
	console.log('========================================');
	console.log('   下一步：');
	console.log('   1. 在 OCS 设置中点击"测试启动 OBS"');
	console.log('   2. 点击"测试 WebSocket 连接"确认正常');
	console.log('   3. 启动浏览器时选择"人脸识别监控-动态场景切换"脚本');
	console.log('========================================\n');

	ws.close();
	rl.close();
}

function connectOBS(port, password) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);

		const timeout = setTimeout(() => {
			resolve(null);
		}, 5000);

		ws.on('open', () => {
			clearTimeout(timeout);
			// 发送 Identify
			const identify = { op: 1, d: { rpcVersion: 1 } };

			if (password) {
				ws.once('message', (data) => {
					try {
						const hello = JSON.parse(data.toString());
						const auth = hello.d?.authentication;
						if (auth) {
							const secret = crypto.createHash('sha256').update(password + auth.salt).digest('base64');
							const authResponse = crypto.createHash('sha256').update(secret + auth.challenge).digest('base64');
							identify.d.authentication = authResponse;
						}
					} catch (e) {
						console.error('认证处理失败:', e.message);
					}
					ws.send(JSON.stringify(identify));
				});
			}

			ws.send(JSON.stringify(identify));

			// 等待 Identified 回复
			ws.once('message', (data) => {
				try {
					const msg = JSON.parse(data.toString());
					if (msg.op === 2 || msg.op === 0) {
						resolve(ws);
					} else {
						resolve(null);
					}
				} catch {
					resolve(null);
				}
			});
		});

		ws.on('error', () => {
			clearTimeout(timeout);
			resolve(null);
		});
	});
}

let requestId = 0;
const pending = {};

function sendRequest(ws, requestType, requestData) {
	return new Promise((resolve, reject) => {
		const rid = String(++requestId);
		pending[rid] = { resolve, reject };

		ws.send(JSON.stringify({
			op: 6,
			d: { requestType, requestId: rid, requestData: requestData || {} }
		}));

		const handler = (data) => {
			try {
				const msg = JSON.parse(data.toString());
				if (msg.op === 7 && msg.d?.requestId === rid) {
					ws.removeListener('message', handler);
					const status = msg.d.requestStatus;
					if (status?.result) {
						resolve(msg.d.responseData || {});
					} else {
						reject(new Error(status?.comment || '未知错误'));
					}
				}
			} catch {}
		};
		ws.on('message', handler);

		setTimeout(() => {
			ws.removeListener('message', handler);
			reject(new Error('请求超时'));
		}, 10000);
	});
}

main().catch(console.error);
