import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { buildSceneHotkeyConfig } from './obs-hotkey';

const ROOT_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const FACE_VIDEOS_DIR = path.join(ROOT_DIR, 'face-videos');

function uuid() {
	return crypto.randomUUID();
}

const SCENES = [
	{ name: 'Normal', file: 'normal.mp4', type: 'media' as const, label: '正常学习' },
	{ name: 'Blink', file: 'blink.mp4', type: 'media' as const, label: '眨眼' },
	{ name: 'Nod', file: 'nod.mp4', type: 'media' as const, label: '点头' },
	{ name: 'TurnHead', file: 'turn-head.mp4', type: 'media' as const, label: '转头' },
	{ name: 'OpenMouth', file: 'open-mouth.mp4', type: 'media' as const, label: '张嘴' },
	{ name: 'Photo', file: 'photo.jpg', type: 'image' as const, label: '静态照片' }
];

/**
 * 自动配置 OBS 人脸识别场景
 * 直接生成场景集合 JSON 文件，不依赖 OBS WebSocket
 */
export function autoSetupOBSScenes(): { success: boolean; message: string; details: string[] } {
	const details: string[] = [];

	// 检查视频文件
	const missingFiles: string[] = [];
	for (const scene of SCENES) {
		const fp = path.join(FACE_VIDEOS_DIR, scene.file);
		if (!fs.existsSync(fp)) {
			missingFiles.push(scene.file + ' (' + scene.label + ')');
		} else {
			details.push(`✅ ${scene.file} (${scene.label})`);
		}
	}

	if (missingFiles.length > 0) {
		details.push(`⚠️ 以下文件缺失: ${missingFiles.join(', ')}`);
	}

	// 生成场景集合
	const sourceUUIDs: Record<string, string> = {};
	const sceneUUIDs: Record<string, string> = {};
	for (const s of SCENES) {
		sourceUUIDs[s.name] = uuid();
		sceneUUIDs[s.name] = uuid();
	}

	const sources: any[] = [];

	// 桌面音频
	sources.push({
		prev_ver: 536936450,
		name: '桌面音频',
		uuid: uuid(),
		id: 'wasapi_output_capture',
		versioned_id: 'wasapi_output_capture',
		settings: { device_id: 'default' },
		mixers: 255, sync: 0, flags: 0, volume: 1.0, balance: 0.5,
		enabled: true, muted: false,
		hotkeys: { 'libobs.mute': [], 'libobs.unmute': [] },
		deinterlace_mode: 0, deinterlace_field_order: 0,
		orientation: 1, monitoring_type: 2
	});

	// 媒体/图像源
	for (const s of SCENES) {
		const filePath = path.join(FACE_VIDEOS_DIR, s.file).replace(/\\/g, '/');
		const isVideo = s.type === 'media';
		const sourceId = isVideo ? 'ffmpeg_source' : 'image_source';

		sources.push({
			name: s.name + '-Source',
			uuid: sourceUUIDs[s.name],
			id: sourceId,
			versioned_id: sourceId,
			settings: isVideo
				? {
						local_file: filePath,
						looping: true,
						is_local_file: true,
						clear_on_media_end: false,
						restart_on_activate: true,
						speed: 100
				  }
				: { file: filePath },
			mixers: 0, sync: 0, flags: 0, volume: 1.0, balance: 0.5,
			enabled: true, muted: false,
			hotkeys: {}
		});
	}

		// 场景（含热键 Ctrl+F1~F6）
		for (let i = 0; i < SCENES.length; i++) {
			const s = SCENES[i];
			sources.push({
				name: s.name,
				uuid: sceneUUIDs[s.name],
				id: 'scene',
				versioned_id: 'scene',
				settings: {
					id_counter: 1,
					custom_size: false,
					items: [{ name: s.name + '-Source', source_uuid: sourceUUIDs[s.name], visible: true }]
				},
				mixers: 0, sync: 0, flags: 0, volume: 1.0, balance: 0.5,
				enabled: true, muted: false,
				hotkeys: buildSceneHotkeyConfig(s.name, i)
			});
		}

	const collection = {
		name: 'FaceCam',
		sources,
		groups: [],
		scene_order: SCENES.map(s => ({ name: s.name })),
		current_scene: 'Normal',
		current_program_scene: 'Normal',
		canvases: [],
		current_transition: 'Fade',
		transition_duration: 300,
		transitions: [],
		quick_transitions: [],
		saved_projectors: [],
		preview_locked: false,
		scaling_enabled: false,
		scaling_level: 0,
		scaling_off_x: 0,
		scaling_off_y: 0,
		'virtual-camera': { type: 'basic' },
		modules: {},
		resolution: { cx: 640, cy: 480 },
		version: 536936450
	};

	// 写入文件（场景集合 + 默认场景）
	const appData = process.env.APPDATA || '';
	const scenesDir = path.join(appData, 'obs-studio', 'basic', 'scenes');
	const faceCamPath = path.join(scenesDir, 'FaceCam.json');
	const defaultPath = path.join(scenesDir, '未命名.json');

	fs.writeFileSync(faceCamPath, JSON.stringify(collection, null, 2));
	fs.writeFileSync(defaultPath, JSON.stringify(collection, null, 2));

	details.push(`✅ 场景集合已写入: ${faceCamPath}`);
	details.push(`✅ 已设为默认场景集合`);
	details.push(`📁 包含 ${SCENES.length} 个场景: ${SCENES.map(s => s.name).join(', ')}`);
	details.push(`👉 重启 OBS 即可生效（点击下方"重启 OBS"按钮）`);

	return {
		success: true,
		message: 'OBS 场景配置成功！',
		details
	};
}
