// 组装完整 userscript: 头部(旧产物提取) + _bundle.js + footer.js(启动入口+样式)
const fs = require('fs');
const dist = __dirname + '/../dist';

// 头部是自引用的（从旧产物提取），Project.domains 改了不会自动反映到 @match。
// 新增 AI 站点时在这里登记，构建时会自动补进头部。
const EXTRA_MATCHES = ['*://*.coze.cn/*', '*://*.deepseek.com/*'];

const old = fs.readFileSync(dist + '/ocs.ai.user.js', 'utf8');
const headerEnd = old.indexOf('// ==/UserScript==');
let header = old.slice(0, headerEnd + '// ==/UserScript=='.length);
if (!header.includes('==UserScript==')) throw new Error('头部提取失败');

// 补齐缺失的 @match（插在 ==/UserScript== 之前）
let added = [];
for (const m of EXTRA_MATCHES) {
	if (!header.includes('// @match        ' + m)) {
		header = header.replace('// ==/UserScript==', '// @match        ' + m + '\n// ==/UserScript==');
		added.push(m);
	}
}

const bundle = fs.readFileSync(dist + '/_bundle.js', 'utf8');
const footer = fs.readFileSync(__dirname + '/footer.js', 'utf8');
fs.writeFileSync(dist + '/ocs.ai.user.js', header + '\n\n' + bundle + '\n' + footer);
console.log('构建完成:', (fs.statSync(dist + '/ocs.ai.user.js').size / 1024).toFixed(1) + 'KB, 含启动footer:', footer.includes('start({'));
if (added.length) console.log('已补 @match:', added.join(', '));;
