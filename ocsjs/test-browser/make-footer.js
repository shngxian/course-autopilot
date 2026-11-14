// 从官方 ocs.user.js 提取 STYLE，生成启动 footer.js
const fs = require('fs');
const official = fs.readFileSync(__dirname + '/ocs-official.js', 'utf8');

// STYLE 是一个完整的 JS 字面量（官方为反引号模板字面量），逐字符扫描提取
const start = official.indexOf('const STYLE =');
if (start < 0) { console.log('STYLE未找到'); process.exit(1); }
let i = official.indexOf('=', start) + 1;
while (official[i] === ' ') i++;
const quote = official[i];
let j = i + 1;
while (official[j] !== quote) {
	if (official[j] === '\\') j++;
	j++;
}
const styleLit = official.substring(i, j + 1);
console.log('STYLE字面量长度:', styleLit.length, '引号类型:', quote, '预览:', styleLit.substring(0, 60).replace(/\n/g, ' '));

const footer = '\n\nconst STYLE = ' + styleLit + ';\n' + [
	"const { start, definedProjects, CommonProject, RenderScript } = OCS;",
	'',
	"const infos = (typeof GM_info !== 'undefined' && GM_info) || { script: { version: '4.15.3-ai' } };",
	'',
	'(function () {',
	"\t'use strict';",
	'',
	'\tconst projects = definedProjects();',
	'',
	'\t// 运行脚本',
	'\tstart({',
	'\t\tprojects: projects,',
	'\t\trenderConfig: {',
	'\t\t\trenderScript: RenderScript,',
	'\t\t\tstyles: [STYLE],',
	'\t\t\tdefaultPanelName: CommonProject.scripts.guide.namespace,',
	"\t\t\ttitle: 'OCS-' + ((infos.script && infos.script.version) || '4.15.3-ai')",
	'\t\t},',
	"\t\tupdatePage: 'https://docs.ocsjs.com/docs/update'",
	'\t});',
	'})();'
].join('\n');

fs.writeFileSync(__dirname + '/footer.js', footer);
console.log('footer.js 已生成:', footer.length, 'bytes');

// 验证 footer 语法
try {
	new Function('OCS', 'GM_info', footer);
	console.log('footer 语法: OK');
} catch (e) {
	console.log('footer 语法错误:', e.message);
	process.exit(1);
}
