/**
 * 创建 OBS 人脸识别场景集合
 * 直接在 OBS 场景目录生成 FaceCam.json
 * 运行时需关闭 OBS
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APPDATA = process.env.APPDATA;
const FACE_DIR = path.resolve(__dirname, '..', '..', 'face-videos');
const OUTPUT = path.join(APPDATA, 'obs-studio', 'basic', 'scenes', 'FaceCam.json');

function uuid() {
	return crypto.randomUUID();
}

const SCENES = [
	{ name: 'Normal', file: 'normal.mp4', type: 'media', label: '正常学习' },
	{ name: 'Blink', file: 'blink.mp4', type: 'media', label: '眨眼' },
	{ name: 'Nod', file: 'nod.mp4', type: 'media', label: '点头' },
	{ name: 'TurnHead', file: 'turn-head.mp4', type: 'media', label: '转头' },
	{ name: 'OpenMouth', file: 'open-mouth.mp4', type: 'media', label: '张嘴' },
	{ name: 'Photo', file: 'photo.jpg', type: 'image', label: '静态照片' }
];

// 检查文件
const missing = [];
for (const s of SCENES) {
	const fp = path.join(FACE_DIR, s.file);
	if (!fs.existsSync(fp)) missing.push(s.file + ' (' + s.label + ')');
}
if (missing.length > 0) {
	console.log('❌ 缺少以下文件:');
	missing.forEach(m => console.log('   - ' + m));
	process.exit(1);
}
console.log('✅ 所有视频/照片文件存在');

// 生成 UUID
const sourceUUIDs = {};
const sceneUUIDs = {};
for (const s of SCENES) {
	sourceUUIDs[s.name] = uuid();
	sceneUUIDs[s.name] = uuid();
}

// 构建 sources
const sources = [];

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

// 视频/图片源
for (const s of SCENES) {
	const filePath = path.join(FACE_DIR, s.file).replace(/\\/g, '/');
	const isVideo = s.type === 'media';
	const sourceId = isVideo ? 'ffmpeg_source' : 'image_source';

	const settings = isVideo
		? {
				local_file: filePath,
				looping: true,
				is_local_file: true,
				clear_on_media_end: false,
				restart_on_activate: true,
				speed: 100,
				subtitle: ''
		  }
		: { file: filePath };

	sources.push({
		name: s.name + '-Source',
		uuid: sourceUUIDs[s.name],
		id: sourceId,
		versioned_id: sourceId,
		settings: settings,
		mixers: 0, sync: 0, flags: 0, volume: 1.0, balance: 0.5,
		enabled: true, muted: false,
		hotkeys: {}
	});
}

// 场景源
for (const s of SCENES) {
	sources.push({
		name: s.name,
		uuid: sceneUUIDs[s.name],
		id: 'scene',
		versioned_id: 'scene',
		settings: {
			id_counter: 1,
			custom_size: false,
			items: [
				{
					name: s.name + '-Source',
					source_uuid: sourceUUIDs[s.name],
					visible: true
				}
			]
		},
		mixers: 0, sync: 0, flags: 0, volume: 1.0, balance: 0.5,
		enabled: true, muted: false,
		hotkeys: {}
	});
}

// 构建完整场景集合
const collection = {
	name: 'FaceCam',
	sources: sources,
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

fs.writeFileSync(OUTPUT, JSON.stringify(collection, null, 2));
console.log('✅ 场景集合已写入: ' + OUTPUT);
console.log('   📁 包含 ' + SCENES.length + ' 个场景:');
SCENES.forEach(s => console.log('      ' + s.name + ' → ' + s.file));
console.log('');
console.log('👉 打开 OBS → 场景集合 → FaceCam → 切换场景测试');
