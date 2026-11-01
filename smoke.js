// 拍拍学（纯前端版）烟测脚本
// 用 Node 跑：node smoke.js
// 验证：文件结构、HTML 引用一致、JS 关键函数、manifest 合法、词典加载

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else      { fail++; console.log('  FAIL  ' + name); }
}

console.log('\n=== 拍拍学 V0.1 纯前端版 烟测 ===\n');

// 1. 文件结构
const files = [
  'index.html',
  'css/style.css',
  'js/app.js',
  'data/dict.json',
  'manifest.webmanifest',
  'sw.js',
  'icon.svg',
  'scf/index.js',
  'deploy-github-pages.md',
  '.gitignore',
];
console.log('[文件结构]');
files.forEach((f) => check(f, fs.existsSync(path.join(__dirname, f))));

// 2. 不能有遗留的后端文件（scf/ 是代理，不是后端）
console.log('\n[清理]');
['api', 'vercel.json'].forEach((f) => {
  check(`已删除 ${f}`, !fs.existsSync(path.join(__dirname, f)));
});

// 3. 词典
console.log('\n[内置词典]');
const dict = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/dict.json'), 'utf-8'));
check('词典是数组', Array.isArray(dict));
check('词条数 >= 200', dict.length >= 200);
['杯子', '马克杯', '猫', '狗', '绿植', '相机', '手机', '雨伞'].forEach((zh) => {
  const hit = dict.find((r) => r.zh === zh);
  check(`"${zh}" 在词典中`, !!hit);
});

// 4. HTML 引用
console.log('\n[index.html 引用]');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
check('引用 css/style.css', html.includes('css/style.css'));
check('引用 js/app.js', html.includes('js/app.js'));
check('引用 manifest.webmanifest', html.includes('manifest.webmanifest'));
check('引用 icon.svg', html.includes('icon.svg'));
check('有 #page-home', html.includes('id="page-home"'));
check('有 #page-result', html.includes('id="page-result"'));
check('有 #page-settings', html.includes('id="page-settings"'));
check('有 #btn-camera', html.includes('id="btn-camera"'));
check('有 #btn-album', html.includes('id="btn-album"'));
check('有 #btn-circle', html.includes('id="btn-circle"'));
check('有 #input-zh', html.includes('id="input-zh"'));
check('有 #input-api-key', html.includes('id="input-api-key"'));
check('有 #btn-settings-save', html.includes('id="btn-settings-save"'));
check('有 #btn-settings-clear', html.includes('id="btn-settings-clear"'));
check('有 manifest link', html.includes('<link rel="manifest"'));
check('有 theme-color meta', html.includes('theme-color'));
check('有 apple-touch-icon', html.includes('apple-touch-icon'));

// 5. manifest.webmanifest
console.log('\n[PWA manifest]');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.webmanifest'), 'utf-8'));
check('有 name', !!manifest.name);
check('有 short_name', !!manifest.short_name);
check('start_url 存在', !!manifest.start_url);
check('display: standalone', manifest.display === 'standalone');
check('theme_color 存在', !!manifest.theme_color);
check('有 icons', Array.isArray(manifest.icons) && manifest.icons.length > 0);
check('icon 指向 icon.svg', manifest.icons[0].src.includes('icon.svg'));

// 6. sw.js
console.log('\n[Service Worker]');
const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf-8');
check('有 CACHE 常量', /const CACHE\s*=\s*'/.test(sw));
check('有 install 事件', sw.includes("addEventListener('install'"));
check('有 fetch 事件', sw.includes("addEventListener('fetch'"));
check('有 ignoreSearch', sw.includes('ignoreSearch'));
check('不缓存豆包', sw.includes('volces.com') && sw.includes('return'));

// 7. JS 关键函数
console.log('\n[JS 主逻辑]');
const appjs = fs.readFileSync(path.join(__dirname, 'js/app.js'), 'utf-8');
const fns = [
  'loadDict', 'getKey', 'setKey', 'ensureKey', 'showSettings',
  'handleImageFile', 'enterCircleMode',
  'exitCircleMode', 'processZhInput', 'speak', 'renderList',
  'callDoubaoVisionRegion', 'callDoubaoLookup', 'lookupLocal',
  'hitTest', 'testConnection', 'fetchModels', 'submitZh', 'cropImageRegion',
];
fns.forEach((fn) => check(`定义 ${fn}()`, appjs.includes(fn)));

// 8. JS 关键行为
console.log('\n[JS 关键行为]');
check('endpoint 走代理 /api/ark', appjs.includes("ARK_PROXY_BASE + '/api/ark'"));
check('代理地址可配置 ARK_PROXY_BASE', appjs.includes('const ARK_PROXY_BASE'));
check('使用 localStorage 存 key', appjs.includes("localStorage.setItem('doubao_api_key'"));
check('无遗留后端接口', !appjs.includes('/api/recognize') && !appjs.includes('/api/lookup'));
check('注册 Service Worker', appjs.includes("register('sw.js')"));
check('使用 speechSynthesis', appjs.includes('speechSynthesis'));

// 9. CSS
console.log('\n[CSS]');
const css = fs.readFileSync(path.join(__dirname, 'css/style.css'), 'utf-8');
check('主色 荧光黄绿 #E3F04B', css.includes('#E3F04B'));
check('有 .settings 样式', css.includes('.settings'));
check('有 .btn-ghost 样式', css.includes('.btn-ghost'));
check('有 .circle-canvas--active 样式', css.includes('.circle-canvas--active'));
check('有 .circle-mask__bar 样式', css.includes('.circle-mask__bar'));
check('有 #btn-add-zh 提交键', html.includes('id="btn-add-zh"'));

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===\n`);
process.exit(fail > 0 ? 1 : 0);
