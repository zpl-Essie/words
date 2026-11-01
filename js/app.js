// 拍拍学 · 主逻辑（纯前端版）
// 流程：拍照 / 选图 → 进入圈画（按原图比例显示）→ 圈出物品 + 输入中文
//       → 本地词典优先、豆包兜底 → 单词表
//
// 用户首次打开会提示填 API key，存在 localStorage，调用豆包时使用。

(function () {
  'use strict';

  // ---------- 豆包 endpoint（经代理转发） ----------
  // 已实测：浏览器直连 ark.cn-beijing.volces.com 会被 CORS 拦截（OPTIONS 预检
  // net::ERR_FAILED），与 key 是否有效无关。所以请求统一走 /api/ark 代理。
  //
  // 代理平台已从 Cloudflare Workers 迁到腾讯云 CloudBase：实测 workers.dev 与
  // vercel.app 在国内解析到被污染的假 IP（如 67.228.235.93），连接直接超时，不可用。
  //
  // 👉 代理已迁到腾讯云 SCF（云函数），免费版超时 90 秒，不再被 CloudBase 3 秒锁死。
  //    地址来自 SCF 控制台的「函数 URL」，公网访问、免鉴权。
  const ARK_PROXY_BASE = 'https://1490422137-0nn0l59cii.ap-shanghai.tencentscf.com';
  const DOUBAO_ENDPOINT = ARK_PROXY_BASE + '/api/ark';

  // 模型 ID 存在本地，可在设置页从「拉取可用模型」的结果里选，也可以自己粘贴。
  // ⚠️ 必须是账号里「在售且已开通」的模型，否则豆包返回 404
  // InvalidEndpointOrModel.NotFound —— 这是「识别不出来」最常见的原因。
  // doubao-1-5-* 系列已陆续下线（官方模型列表标注「即将下线」），故默认改用 Doubao-Seed 2.1：
  // Seed 2.1 原生多模态，同一个模型既能看图也能查词，省得配两个。
  // 具体 ID 以方舟控制台「开通管理 / 模型列表」里显示的为准，点「拉取可用模型」会自动覆盖这里。
  // 已确认可用：doubao-seed-2-0-mini-260428（全模态理解，支持图片输入，轻量便宜）
  const DEFAULT_VISION_MODEL = 'doubao-seed-2-0-mini-260428';
  const DEFAULT_TEXT_MODEL = 'doubao-seed-2-0-mini-260428';
  function getVisionModel() {
    return localStorage.getItem('doubao_vision_model') || DEFAULT_VISION_MODEL;
  }
  function getTextModel() {
    return localStorage.getItem('doubao_text_model') || DEFAULT_TEXT_MODEL;
  }

  // 构建标记：显示在设置页底部，只为一眼确认「手机跑的是哪一版」（排查 SW 缓存用）
  const BUILD_TAG = '2026-11-01 · DEMO';

  // ---------- 状态 ----------
  const state = {
    photos: [],               // [{ dataURL, rawDataURL, ar }] —— 多图列表
    activePhotoIdx: 0,        // 当前显示/圈画的是第几张
    items: [],                // 跨所有图汇总的单词
    isCircleMode: false,
    circles: [],              // { x1,y1,x2,y2, used, label, photoIdx }
    currentCircle: null,
    photoAR: null,            // 当前 active 图的宽高比（给 canvas 用）
    dialog: null,             // 当前生成的对话
    savedDialogs: [],         // 从 localStorage 读的历史对话 [{ dialog, itemsUsed, savedAt }]
    isDemo: false,            // 演示模式：照片/识别/对话全部预置，不调用接口
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    pageHome: $('page-home'),
    pageResult: $('page-result'),
    pageSettings: $('page-settings'),
    pageVocab: $('page-vocab'),
    tabHome: $('tab-home'),
    tabVocab: $('tab-vocab'),
    tabSettings: $('tab-settings'),
    btnCamera: $('btn-camera'),
    btnAlbum: $('btn-album'),
    fileCamera: $('file-camera'),
    fileAlbum: $('file-album'),
    btnBack: $('btn-back'),
    btnAddPhoto: $('btn-add-photo'),
    photoCounter: $('photo-counter'),
    btnSettingsBack: $('btn-settings-back'),
    btnSettingsSave: $('btn-settings-save'),
    btnSettingsClear: $('btn-settings-clear'),
    inputApiKey: $('input-api-key'),
    inputKeyHint: $('input-key-hint'),
    keyStatus: $('key-status'),
    btnSettingsTest: $('btn-settings-test'),
    testStatus: $('test-status'),
    buildTag: $('build-tag'),
    photoImg: $('photo-img'),
    canvas: $('circle-canvas'),
    photoWrap: $('photo-wrap'),
    status: $('status'),
    itemCount: $('item-count'),
    wordlistUl: $('wordlist-ul'),
    btnCircle: $('btn-circle'),
    btnGenerate: $('btn-generate'),
    circleMask: $('circle-mask'),
    circleMaskTop: $('circle-mask-top'),
    circleMaskBar: $('circle-mask-bar'),
    circleMaskTip: $('circle-mask-tip'),
    btnCircleUndo: $('btn-circle-undo'),
    btnCircleDone: $('btn-circle-done'),
    inputZh: $('input-zh'),
    btnAddZh: $('btn-add-zh'),
    btnFetchModels: $('btn-fetch-models'),
    inputVisionModel: $('input-vision-model'),
    inputTextModel: $('input-text-model'),
    modelOptions: $('model-options'),
    modelStatus: $('model-status'),
    loading: $('loading'),
    loadingText: $('loading-text'),
    toast: $('toast'),
    // 对话 modal
    dialogModal: $('dialog-modal'),
    dialogModalClose: $('dialog-modal-close'),
    dialogModalScene: $('dialog-modal-scene'),
    dialogModalBody: $('dialog-modal-body'),
    dialogModalSave: $('dialog-modal-save'),
    // 生词本
    vocabEmpty: $('vocab-empty'),
    vocabList: $('vocab-list'),
    // 演示模式
    btnDemo: $('btn-demo'),
    demoBadge: $('demo-badge'),
    actionbarHint: $('actionbar-hint'),
  };

  // ---------- 内置词典（启动时一次 fetch） ----------
  let DICT = {};
  async function loadDict() {
    try {
      const r = await fetch('data/dict.json');
      const arr = await r.json();
      arr.forEach((row) => {
        if (row.zh) DICT[row.zh] = row;
      });
    } catch (e) {
      console.warn('dict.json 加载失败，纯靠 AI 兜底', e);
    }
  }

  // ---------- Key 管理 ----------
  function getKey() {
    return localStorage.getItem('doubao_api_key') || '';
  }
  function setKey(k) {
    if (k) localStorage.setItem('doubao_api_key', k);
    else localStorage.removeItem('doubao_api_key');
  }
  function ensureKey() {
    if (state.isDemo) return true; // 演示模式不需要 key
    if (!getKey()) {
      showSettings(true);
      return false;
    }
    return true;
  }

  // 判断豆包错误是否是「额度/余额不足」类问题，是则跳设置页并给明确提示。
  // 触发条件：HTTP 402（余额不足）、429 且消息提额度、或错误消息含余额/额度/quota/insufficient/欠费。
  function isQuotaError(msg) {
    return /402|余额|额度不足|额度耗尽|quota|insufficient|欠费|余额不足/.test(msg)
      || (/429/.test(msg) && /额度|quota|限流|rate/.test(msg));
  }
  function handleDoubaoError(msg) {
    if (isQuotaError(msg)) {
      showToast('豆包额度用完了，去充值或换个模型');
      showSettings(true);
      return true;
    }
    if (/未配置 API key|401|403/.test(msg)) {
      showSettings(true);
      return true;
    }
    return false;
  }
  function showSettings(force) {
    els.pageHome.classList.remove('page--active');
    els.pageResult.classList.remove('page--active');
    els.pageVocab.classList.remove('page--active');
    els.pageSettings.classList.add('page--active');
    els.tabHome.classList.remove('tab--active');
    els.tabVocab.classList.remove('tab--active');
    els.tabSettings.classList.add('tab--active');
    const cur = getKey();
    els.inputApiKey.value = cur;
    els.inputKeyHint.textContent = cur
      ? '已配置（不会显示完整 key）。如需更换请直接覆盖。'
      : '首次使用需填入你的豆包 API key（自己注册火山引擎获取）。key 只存在你自己浏览器。';
    els.keyStatus.textContent = cur ? '✓ 已配置' : '未配置';
    syncModelUI();
  }
  function hideSettings() {
    els.pageSettings.classList.remove('page--active');
    // 默认回首页
    if (!els.pageHome.classList.contains('page--active') &&
        !els.pageResult.classList.contains('page--active')) {
      els.pageHome.classList.add('page--active');
    }
  }

  // 测试连接：分别打一次文本模型和视觉模型，把真实报错原样显示出来。
  // 「到底连没连上豆包、key 有没有效、模型有没有开通」在这里给答案。
  async function testConnection() {
    const out = els.testStatus;
    const apiKey = getKey();
    if (!apiKey) { out.textContent = '请先填写并保存 key'; return; }
    out.textContent = '正在测试…';

    const lines = [];
    const probe = async (label, model, withImage) => {
      const content = withImage
        ? [
            { type: 'text', text: '这是什么颜色？只回一个词。' },
            { type: 'image_url', image_url: { url: canvasToDataURL(24, 24, 0.6, (ctx) => {
              ctx.fillStyle = '#E3F04B';
              ctx.fillRect(0, 0, 24, 24);
            }) } },
          ]
        : '回复一个字：好';
      // 共用 fetchWithRetry：30 秒超时 + 自动重试 1 次。CloudBase 免费版冷启动偶发网络层断连，
      // 重试基本能通。视觉请求 payload 更大（带 base64），超时 45 秒。
      const timeout = withImage ? 45000 : 25000;
      try {
        const r = await fetchWithRetry(DOUBAO_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
          },
          body: JSON.stringify({ model: model, messages: [{ role: 'user', content: content }], max_tokens: 16 }),
        }, timeout, 1);
        const t = await r.text();
        if (r.ok) {
          lines.push('✓ ' + label + '：' + model);
        } else {
          const noAccess =
            r.status === 404 && /InvalidEndpointOrModel|you do not have access/i.test(t);
          lines.push('✗ ' + label + '（' + r.status + '）：' + t.slice(0, 160) +
            (noAccess
              ? '  → 这个模型没开通：去方舟控制台「开通管理」开通，或点上面的「拉取可用模型」挑一个已开通的'
              : ''));
        }
      } catch (e) {
        const msg = (e && e.message) || '未知错误';
        lines.push('✗ ' + label + '：' + msg);
      }
    };

    await probe('文本模型', getTextModel(), false);
    await probe('视觉模型', getVisionModel(), true);
    out.innerHTML = lines.map(escapeHtml).join('<br>');
  }

  // ---------- 模型列表：拉一次就知道账号里有哪些可用模型 ----------
  function fillModelOptions(ids) {
    els.modelOptions.innerHTML = '';
    ids.forEach((id) => {
      const o = document.createElement('option');
      o.value = id;
      els.modelOptions.appendChild(o);
    });
  }
  // 从 doubao-seed-2-1-pro-260915 这类 ID 末尾取 6 位版本号，用来比新旧
  function modelDate(id) {
    const m = /-(\d{6})(?!\d)/.exec(id);
    return m ? Number(m[1]) : 0;
  }
  // 候选里挑最合适的：优先 Seed 系列（新架构、有免费额度），其次按版本号从新到旧
  function pickNewest(ids) {
    return ids.slice().sort((a, b) => {
      const sa = /seed/i.test(a) ? 1 : 0;
      const sb = /seed/i.test(b) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return modelDate(b) - modelDate(a);
    })[0] || '';
  }
  function pickVisionModel(ids) {
    const vision = ids.filter((i) => /vision/i.test(i) && !/embed/i.test(i));
    if (!vision.length) return pickNewest(ids);
    // 视觉优先 seed 系多模态，没有就挑最新的 vision 型号
    const seedVision = vision.filter((i) => /seed/i.test(i));
    return pickNewest(seedVision.length ? seedVision : vision);
  }
  function pickTextModel(ids) {
    // 文本要排除掉非对话类：向量、绘图、语音、视频、以及 seedance/seedream 这些衍生型号
    const usable = ids.filter((i) =>
      !/vision|embed|image|tts|asr|video|music|audio|speech|seedance|seedream|3d|ocr/i.test(i));
    const pool = usable.length ? usable : ids;
    // 再排除思维链/角色扮演/代码等专用型号，避免又慢又贵
    const plain = pool.filter((i) => !/thinking|character|reason|code/i.test(i));
    const base = plain.length ? plain : pool;
    const seed = base.filter((i) => /seed/i.test(i));
    return pickNewest(seed.length ? seed : base);
  }
  function syncModelUI() {
    els.inputVisionModel.value = getVisionModel();
    els.inputTextModel.value = getTextModel();
    els.modelStatus.textContent = '当前视觉：' + getVisionModel() + '｜文本：' + getTextModel();
  }

  // GET 代理拿 /api/v3/models 列表。404 说明云函数还是旧版（只支持 POST），需要重新部署。
  async function fetchModels() {
    const apiKey = getKey();
    if (!apiKey) { els.modelStatus.textContent = '请先填写并保存 key'; return; }
    els.modelStatus.textContent = '正在拉取…';
    try {
      const r = await fetchWithTimeout(DOUBAO_ENDPOINT, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + apiKey },
      }, 20000);
      const t = await r.text();
      if (!r.ok) {
        const hint = (r.status === 404 || r.status === 405)
          ? '（云函数可能还是旧版：去腾讯云 SCF 控制台把 scf/index.js 重新粘贴、部署一次）'
          : '';
        els.modelStatus.textContent = '✗ 拉取失败（' + r.status + '）：' + t.slice(0, 160) + hint;
        return;
      }
      const ids = (((JSON.parse(t) || {}).data) || []).map((m) => m.id).filter(Boolean);
      if (!ids.length) {
        els.modelStatus.textContent = '账号下没有可用模型：去方舟控制台「开通管理」开通后再拉';
        return;
      }
      const vision = pickVisionModel(ids);
      const text = pickTextModel(ids);
      fillModelOptions(ids);
      els.inputVisionModel.value = vision;
      els.inputTextModel.value = text;
      localStorage.setItem('doubao_vision_model', vision);
      localStorage.setItem('doubao_text_model', text);
      syncModelUI();
      const seedCount = ids.filter((i) => /seed/i.test(i)).length;
      els.modelStatus.textContent =
        '共 ' + ids.length + ' 个可用模型，已自动选好'
        + (seedCount ? '（Seed 系列 ' + seedCount + ' 个）' : '')
        + '；若「测试连接」仍报 404，说明这个模型还没开通：去方舟控制台「开通管理」开通即可';
    } catch (e) {
      els.modelStatus.textContent = '✗ ' + ((e && e.message) || '未知错误');
    }
  }

  // ---------- 工具 ----------
  function showToast(msg, ms = 1800) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => (els.toast.hidden = true), ms);
  }

  function showLoading(text = '正在看图中…') {
    els.loadingText.textContent = text;
    els.loading.hidden = false;
  }
  function hideLoading() {
    els.loading.hidden = true;
  }

  function switchPage(to) {
    hideLoading(); // 切换页面时关掉加载层，避免请求挂起后卡在上一页
    els.pageHome.classList.remove('page--active');
    els.pageResult.classList.remove('page--active');
    els.pageSettings.classList.remove('page--active');
    els.pageVocab.classList.remove('page--active');
    els.tabHome.classList.remove('tab--active');
    els.tabVocab.classList.remove('tab--active');
    els.tabSettings.classList.remove('tab--active');
    if (to === 'result') { els.pageResult.classList.add('page--active'); els.tabHome.classList.add('tab--active'); }
    else if (to === 'settings') { els.pageSettings.classList.add('page--active'); els.tabSettings.classList.add('tab--active'); }
    else if (to === 'vocab') { els.pageVocab.classList.add('page--active'); els.tabVocab.classList.add('tab--active'); renderVocabPage(); }
    else { els.pageHome.classList.add('page--active'); els.tabHome.classList.add('tab--active'); }
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  // ---------- 图片压缩 ----------
  // ⚠️ CloudBase HTTP 网关的请求体上限实测只有 100KB（超出即 413
  // EXCEED_MAX_PAYLOAD_SIZE）。从浏览器侧看，连接会被服务端掐断、fetch 抛
  // TypeError，表现成「网络连接失败」——其实是图太大，不是网络问题。
  // 手机原图转 base64 动辄 500KB+，所以必须把图压进预算再发。
  const IMG_BUDGET = 92 * 1024; // dataURL 字符数预算，留约 8KB 给 JSON 结构
  // 依次尝试：优先保分辨率、只降质量；实在不行再降分辨率
  const IMG_ATTEMPTS = [
    [1024, 0.70], [1024, 0.55], [1024, 0.42],
    [800, 0.50], [800, 0.40],
    [640, 0.40], [512, 0.35],
  ];

  function loadImage(dataURL) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataURL;
    });
  }

  function canvasToDataURL(w, h, quality, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    return c.toDataURL('image/jpeg', quality);
  }

  async function compressImage(dataURL) {
    let img;
    try { img = await loadImage(dataURL); }
    catch (e) { return dataURL; } // 解码失败就原样发，让上游去报错

    let fallback = null;
    for (const [maxSize, quality] of IMG_ATTEMPTS) {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const out = canvasToDataURL(w, h, quality, (ctx) => ctx.drawImage(img, 0, 0, w, h));
      if (out.length <= IMG_BUDGET) return out;
      fallback = out;
    }
    return fallback;
  }

  // 裁剪区域的发送预算：依次尝试「保分辨率 / 保质量 / 再降分辨率」，
  // 取第一个塞得进 92KB 的结果，都不行就用最后那个（豆包还能看个大概）。
  const CROP_ATTEMPTS = [
    [1400, 0.80], [1400, 0.60], [1024, 0.70],
    [1024, 0.55], [800, 0.60], [640, 0.55], [512, 0.50], [384, 0.45],
  ];

  // 按归一化坐标（0-1）从**原图**裁剪圈选区域。
  // 照片现在按原图比例铺满 .photo-wrap（object-fit 不再裁切），
  // 所以框上的归一化坐标 = 原图的归一化坐标，直接用，不用再做映射。
  // 用原图而不是压缩图，是为了让圈得小的物品也能看清。
  async function cropImageRegion(dataURL, norm) {
    let img;
    try { img = await loadImage(dataURL); }
    catch (e) { return dataURL; } // 失败兜底发整图

    const pad = 0.02; // 外扩一点，避免贴边切掉物品
    const x1 = Math.max(0, norm.x1 - pad), y1 = Math.max(0, norm.y1 - pad);
    const x2 = Math.min(1, norm.x2 + pad), y2 = Math.min(1, norm.y2 + pad);
    const sx = Math.round(x1 * img.width), sy = Math.round(y1 * img.height);
    const sw = Math.max(1, Math.round((x2 - x1) * img.width));
    const sh = Math.max(1, Math.round((y2 - y1) * img.height));

    let fallback = null;
    for (const [maxSide, quality] of CROP_ATTEMPTS) {
      const s = Math.min(1, maxSide / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * s));
      const h = Math.max(1, Math.round(sh * s));
      const out = canvasToDataURL(w, h, quality,
        (ctx) => ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h));
      if (out.length <= IMG_BUDGET) return out;
      fallback = out;
    }
    return fallback;
  }

  // ---------- 朗读（Web Speech API） ----------
  // Android Chrome 的语音列表是异步加载的，启动时先 warm 一份，
  // 否则第一次点喇叭可能因为没有可用 voice 而静默失败。
  let VOICES = [];
  function warmVoices() {
    if (!('speechSynthesis' in window)) return;
    const load = () => { VOICES = window.speechSynthesis.getVoices() || []; };
    load();
    window.speechSynthesis.onvoiceschanged = load;
  }

  // 复用同一个 Audio 对象，连点时先停旧的，避免多段音频叠播
  let ttsAudio = null;
  let ttsObjectUrl = null;
  let ttsCtx = null;        // Web Audio 上下文：整句播放的主通道
  let ttsSrcNode = null;    // 当前在播的 BufferSource，连点时先停
  // 正在播放的喇叭按钮：加 is-playing 类做脉冲动效，播完移除
  let playingBtn = null;
  function setPlaying(btn) {
    if (playingBtn && playingBtn !== btn) playingBtn.classList.remove('is-playing');
    playingBtn = btn || null;
    if (playingBtn) playingBtn.classList.add('is-playing');
  }
  function clearPlaying() {
    if (playingBtn) playingBtn.classList.remove('is-playing');
    playingBtn = null;
  }
  // SCF 函数 URL 网关不会解码 isBase64Encoded 响应：body 实为 base64 文本。
  // 真二进制 MP3 以 0xFF 帧同步或 "ID3" 开头；base64 文本则全为可打印 ASCII。
  function maybeDecodeBase64Body(buf) {
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0xFF || (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33)) return buf;
    const n = Math.min(u8.length, 64);
    for (let i = 0; i < n; i++) {
      const c = u8[i];
      const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61 || c === 13 || c === 10;
      if (!ok) return buf; // 出现非 base64 字符 → 是真二进制，原样返回
    }
    try {
      let s = '';
      const CH = 0x8000;
      for (let i = 0; i < u8.length; i += CH) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      }
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out.buffer;
    } catch (e) {
      return buf;
    }
  }
  // 走 SCF 代理：服务端转发百度 gettts（支持整句；百度对浏览器直连做 Referer 防盗链）
  // 两个坑都已实测确认：
  // 1) SCF 函数 URL 平台强制加 Content-Disposition: attachment，<audio> 直连 URL 会被当成下载拒播；
  // 2) fetch 是异步的，等音频下完「点击手势」已过期，<audio>.play() 会被自动播放策略拦下。
  // 解法：点击瞬间（手势有效期内）创建并 resume AudioContext，音频 fetch 完用 Web Audio 播。
  async function playViaProxy(en, btn) {
    if (!en) return;
    // 手势内同步解锁 AudioContext
    let resumePromise = null;
    try {
      if (!ttsCtx) ttsCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (ttsCtx.state === 'suspended') resumePromise = ttsCtx.resume();
    } catch (e) {}
    // 停掉上一段
    if (ttsSrcNode) { try { ttsSrcNode.stop(); } catch (e) {} ttsSrcNode = null; }
    if (ttsAudio) { ttsAudio.pause(); ttsAudio.onerror = null; try { ttsAudio.currentTime = 0; } catch (e) {} }
    clearPlaying();
    showToast('正在加载发音…');
    let buf;
    try {
      const r = await fetch(DOUBAO_ENDPOINT + '?tts=' + encodeURIComponent(en));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      buf = maybeDecodeBase64Body(await r.arrayBuffer());
    } catch (e) {
      showToast('发音加载失败：网络异常');
      return;
    }
    // 主通道：Web Audio
    try {
      if (!ttsCtx) throw new Error('no AudioContext');
      if (resumePromise) await resumePromise;
      // decodeAudioData 会 detach buffer，先复制一份留给兜底用
      const audioBuf = await new Promise((resolve, reject) => {
        const p = ttsCtx.decodeAudioData(buf.slice(0), resolve, reject);
        if (p && p.then) p.then(resolve, reject);
      });
      const src = ttsCtx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(ttsCtx.destination);
      src.start(0);
      ttsSrcNode = src;
      setPlaying(btn);
      src.onended = () => { if (ttsSrcNode === src) { ttsSrcNode = null; clearPlaying(); } };
      return;
    } catch (e) {}
    // 兜底：<audio> + Blob（桌面等宽松环境能过自动播放策略）
    try {
      if (!ttsAudio) ttsAudio = new Audio();
      if (ttsObjectUrl) { try { URL.revokeObjectURL(ttsObjectUrl); } catch (e) {} }
      ttsObjectUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
      ttsAudio.src = ttsObjectUrl;
      await ttsAudio.play();
      setPlaying(btn);
      ttsAudio.onended = clearPlaying;
    } catch (e) {
      showToast('发音加载失败：' + ((e && e.message) || '未知原因'));
    }
  }
  // 单词走有道直连（快、免费）；有道不支持整句（HTTP 500），整句直接走代理
  function playOnline(en, btn) {
    if (!en) return;
    const isSentence = /\s/.test(en.trim());
    if (isSentence) { playViaProxy(en, btn); return; }
    if (!ttsAudio) ttsAudio = new Audio();
    ttsAudio.pause();
    try { ttsAudio.currentTime = 0; } catch (e) {}
    clearPlaying();
    ttsAudio.onerror = () => playViaProxy(en, btn); // 有道偶发失败时还有代理兜底
    ttsAudio.src = 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(en) + '&type=2';
    ttsAudio.play().then(() => {
      setPlaying(btn);
      ttsAudio.onended = clearPlaying;
    }).catch(() => playViaProxy(en, btn));
  }

  function speak(en, btn) {
    if (!en) return;
    // vivo / 夸克 / UC / 微信 / OPPO / 华为 / 小米 等国产内核的 speechSynthesis
    // 多为「假支持」：API 在，但读长句时不出声也不报错。这类浏览器直接走在线 TTS。
    const fakeSynth = !('speechSynthesis' in window) ||
      /vivo|quark|ucbrowser|micromessenger|heytap|oppo|huaweibrowser|honor|miui|xiaomi|samsungbrowser/i.test(navigator.userAgent);
    if (fakeSynth) { playOnline(en, btn); return; }
    try {
      const synth = window.speechSynthesis;
      let started = false;           // 是否真的出过声
      let fallbackTimer = null;
      const goFallback = () => {
        if (started) return;
        try { synth.cancel(); } catch (e) {}
        playOnline(en, btn);
      };
      if (synth.paused) synth.resume();
      synth.cancel();
      clearPlaying();
      setTimeout(() => {
        const u = new SpeechSynthesisUtterance(en);
        u.lang = 'en-US';
        const v = VOICES.find((x) => /en[-_]US/i.test(x.lang))
          || VOICES.find((x) => /^en/i.test(x.lang));
        if (v) u.voice = v;
        u.rate = 0.9;
        u.onstart = () => {
          started = true;
          if (fallbackTimer) clearTimeout(fallbackTimer);
          setPlaying(btn);
        };
        u.onend = () => { if (started) clearPlaying(); };
        u.onerror = () => {
          // 已经出声后中途出错不重复播；没出声过就交给在线 TTS 兜底
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (!started) playOnline(en, btn);
        };
        synth.speak(u);
        // 看门狗：900ms 内没有 onstart，判定为假支持，立刻切在线 TTS
        fallbackTimer = setTimeout(goFallback, 900);
      }, 50);
    } catch (e) {
      playOnline(en, btn);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- 调豆包 ----------
  // 带超时的 fetch：请求挂起时主动中断，避免 loading 永远转
  async function fetchWithTimeout(url, options, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时，请检查网络后重试');
      if (e instanceof TypeError) throw new Error('网络连接失败，请检查网络后重试');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // 网络层错误自动重试：CloudBase 免费版云函数有冷启动，放久了第一次请求常
  // 直接连接失败（TypeError），隔 0.8s 再来一次基本就通——这就是用户感受到的
  // 「多试几次又可以」。重试只针对网络层错误，HTTP 报错（4xx/5xx）不重试。
  async function fetchWithRetry(url, options, ms, retries = 1) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fetchWithTimeout(url, options, ms);
      } catch (e) {
        const retryable = /网络连接失败|请求超时/.test((e && e.message) || '');
        if (!retryable || attempt === retries) throw e;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  // 只用于「圈选区域、用户不知道物品名」这一种场景：让豆包纯看图识物，
  // 返回物品的中英文名称。（知道名字时不发图，直接纯文本查词，省 token。）
  async function callDoubaoVisionRegion(image) {
    const apiKey = getKey();
    if (!apiKey) throw new Error('未配置 API key');

    const askText = '这是用户从照片里圈出来的一块区域。请识别区域里最显眼的那个物品，'
      + '返回它最常用的英文单词（单数形式）和中文名称，返回 JSON：'
      + '{"items":[{"en":"英文单词（单数）","zh":"中文名称","phonetic":"音标"}]}。'
      + '优先日常词汇，避免生僻词；区域里有多个物品时，选最显眼/居中的一个。';

    const r = await fetchWithRetry(DOUBAO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getVisionModel(),
        messages: [
          { role: 'system', content: '你是一个帮助英语学习者识别物品的助手。' },
          {
            role: 'user',
            content: [
              { type: 'text', text: askText },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
        temperature: 0.2,
      }),
    }, 45000); // 视觉识别较慢，给 45s

    if (!r.ok) {
      const t = await r.text();
      throw new Error(`豆包 ${r.status}: ${t.slice(0, 200)}`);
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = typeof content === 'string' ? JSON.parse(content) : content; }
    catch (e) { throw new Error('豆包返回非 JSON'); }
    return Array.isArray(parsed.items) ? parsed.items : [];
  }

  async function callDoubaoLookup(zh) {
    const apiKey = getKey();
    if (!apiKey) throw new Error('未配置 API key');

    const r = await fetchWithRetry(DOUBAO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getTextModel(),
        messages: [
          { role: 'system', content: '你是一个中英词典助手。用户给一个中文词（物品、服装、动物、食品等均可），请返回它最常用的英文单词（单数形式）。尽量翻译常见词汇，包括具体型号和类名（如"短裤"→shorts、"牛仔裤"→jeans、"裤子"→pants）。只有真的无法对应才返回空。' },
          { role: 'user', content: `中文：${zh}\n\n请返回 JSON：{"en":"英文","phonetic":"音标"} 或 {"en":""} 表示无法识别。` },
        ],
        temperature: 0.1,
      }),
    }, 15000);

    const statusTxt = `HTTP ${r.status}`;
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json())?.error?.message || (await r.text()).slice(0, 200); } catch (e) {}
      throw new Error(`豆包查词失败 ${statusTxt}：${detail || '未知'}`);
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = typeof content === 'string' ? JSON.parse(content) : content; }
    catch (e) { throw new Error(`豆包返回非 JSON（${statusTxt}），原始：${String(content).slice(0, 200)}`); }
    // 兼容豆包可能返回的各种变体：en='' / null / undefined / falsy
    const en = parsed.en || parsed.english || parsed.word;
    if (!en) throw new Error(`豆包没给英文，原始返回：${JSON.stringify(parsed).slice(0, 200)}`);
    return { zh, en: String(en).trim(), phonetic: parsed.phonetic || parsed.ipa || '' };
  }

  // ---- 对话生成：把当前单词表塞给豆包，编一段用到这些词的日常场景英文对话 ----
  async function callDoubaoDialog(items) {
    const apiKey = getKey();
    if (!apiKey) throw new Error('未配置 API key');

    // CloudBase 免费版云函数有冷启动问题：10 分钟不用就睡，第一次请求网络层直接断连。
    // 加个 warmup：先发一个极轻量请求把云函数拉醒，再发真正的对话请求。
    try {
      await fetchWithRetry(DOUBAO_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: getTextModel(),
          messages: [{ role: 'user', content: '好' }],
          max_tokens: 1,
        }),
      }, 15000, 1);
    } catch (e) {
      // warmup 失败就算了，让下面的真实请求去扛重试，不要让用户等两次报错
    }

    const words = items.map((it) => `  - ${it.en} (${it.zh}${it.phonetic ? ', ' + it.phonetic : ''})`).join('\n');
    const askText = `下面是用户今天学的英文单词，请编一段日常场景的英文对话（2~4 轮），`
      + `自然地用到其中至少 3 个词。返回 JSON：\n`
      + `{"scene":"一句话描述对话发生在哪里、谁在说话","turns":[{"speaker":"A 或 B","en":"英文句子","zh":"中文翻译","highlights":["用到的单词"]}]}\n\n单词：\n${words}`;

    const r = await fetchWithRetry(DOUBAO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getTextModel(),
        messages: [
          { role: 'system', content: '你是一位英语老师，会把学生今天学的单词自然地放进一段两人的日常对话里。对话用简体中文翻译，不要用拼音。' },
          { role: 'user', content: askText },
        ],
        temperature: 0.7,
      }),
    }, 45000, 2); // 对话生成比查词慢 + CloudBase 冷启动可能断连，多重试一次

    const statusTxt = `HTTP ${r.status}`;
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json())?.error?.message || (await r.text()).slice(0, 200); } catch (e) {}
      throw new Error(`豆包 ${statusTxt}：${detail || '未知错误'}`);
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = typeof content === 'string' ? JSON.parse(content) : content; }
    catch (e) { throw new Error(`豆包返回非 JSON（${statusTxt}）`); }
    if (!Array.isArray(parsed.turns) || parsed.turns.length === 0) throw new Error(`豆包没编出对话（${statusTxt}）`);
    return { scene: parsed.scene || '', turns: parsed.turns };
  }
  function lookupLocal(zh) {
    const k = zh.trim();
    return DICT[k] || null;
  }

  // ---------- 演示模式 ----------
  // 照片来自 demo/，识别结果与对话写在 js/demo-data.js，全程不请求接口。
  // 只有 state.isDemo 为 true 时才走下面的分支，真实 BYOK 流程完全不变。
  function demoData() {
    return window.PAIPAI_DEMO || null;
  }
  function demoWait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function demoPhoto() {
    const d = demoData();
    return d ? d.photos[state.activePhotoIdx] : null;
  }
  // 演示查词：内置词典优先，其次 demo-data 补的词
  function demoLookup(zh) {
    const k = String(zh || '').trim();
    const local = lookupLocal(k);
    if (local) return { en: local.en, zh: local.zh || k, phonetic: local.phonetic || '' };
    const extra = (demoData() && demoData().words) || {};
    if (extra[k]) return { en: extra[k].en, zh: k, phonetic: extra[k].phonetic || '' };
    return null;
  }
  // 用「交叠面积 ÷ 较小那个框」衡量用户圈选区域和预置物品框的重合度
  function demoBoxScore(a, b) {
    const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
    const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const inter = ix * iy;
    const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
    const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
    return inter / Math.min(areaA, areaB);
  }
  // 预置识图：找到和用户圈选区域最重合、且还没加入词表的物品
  function demoRecognize(target) {
    const photo = demoPhoto();
    if (!photo || !photo.items) return null;
    let best = null;
    photo.items.forEach((it) => {
      if (state.items.some((x) => x.en.toLowerCase() === it.en.toLowerCase())) return;
      const box = { x1: it.box[0], y1: it.box[1], x2: it.box[2], y2: it.box[3] };
      const score = demoBoxScore(target, box);
      if (score >= 0.32 && (!best || score > best.score)) best = { it, score };
    });
    return best ? best.it : null;
  }

  async function demoProcessInput(zh, target, settle) {
    // 输入中文：查预置词库
    if (zh) {
      showLoading('正在查词…');
      await demoWait(600);
      hideLoading();
      const word = demoLookup(zh);
      if (!word) {
        els.status.textContent = '演示词库没有「' + zh + '」';
        showToast('演示只收录了示例词，填入 key 后可查任意词');
        return;
      }
      if (state.items.some((x) => x.en.toLowerCase() === word.en.toLowerCase())) {
        els.status.textContent = word.en + ' 已在列表中';
        els.inputZh.value = '';
        syncAddBtn();
        return;
      }
      addItem(word, target);
      els.status.textContent = '已加入：' + word.en + '（演示）';
      settle(word.en);
      return;
    }

    // 留空点「识别」：用预置框位模拟识图
    if (!target) { showToast('先圈一个物品，或直接输入中文'); return; }
    const hit = demoRecognize(target);
    if (hit) {
      addItem({ en: hit.en, zh: hit.zh, phonetic: hit.phonetic }, target);
      els.status.textContent = '已加入：' + hit.en + '（预置识别）';
      settle(hit.en);
      return;
    }
    els.status.textContent = '演示模式只认示例里的物品';
    showToast('没匹配到预置物品：换个框，或输入中文试试');
  }

  // 进入演示：加载两张示例照片，把 preload 物品连圈带词一起摆好
  async function startDemo() {
    if (state.isDemo && state.photos.length) { switchPage('result'); return; }
    const d = demoData();
    if (!d) { showToast('演示数据未加载'); return; }
    try {
      const photos = await Promise.all(d.photos.map(async (p) => {
        const img = await loadImage(p.src);
        return { dataURL: p.src, rawDataURL: p.src, ar: img.width + ' / ' + img.height };
      }));
      state.isDemo = true;
      state.photos = photos;
      state.activePhotoIdx = 0;
      state.items = [];
      state.circles = [];
      state.dialog = null;
      d.photos.forEach((p, pi) => {
        (p.items || []).forEach((it) => {
          if (!it.preload) return;
          const circle = {
            x1: it.box[0], y1: it.box[1], x2: it.box[2], y2: it.box[3],
            used: true, label: it.en, photoIdx: pi,
          };
          state.circles.push(circle);
          state.items.push({ en: it.en, zh: it.zh, phonetic: it.phonetic, circle });
        });
      });
      state.photoAR = photos[0].ar;
      els.demoBadge.hidden = false;
      els.actionbarHint.textContent = '演示模式：识别与对话都是预置结果；填 key 后可拍自己的照片';
      switchPage('result');
      renderPhoto();
      renderList();
      updatePhotoCounter();
      // 页面显示后画布才有尺寸，再同步重画一次，确保预置圈可见
      setTimeout(() => { syncCanvasSize(); redrawCircles(); }, 80);
      showToast('演示模式：不用 key，直接体验');
    } catch (e) {
      console.error(e);
      showToast('演示照片加载失败');
    }
  }

  // 生成对话：直接取当前照片对应的预置对话，带一点假 loading 和逐条浮现
  async function generateDemoDialog() {
    const d = demoData();
    const dialog = d && (d.dialogs[state.activePhotoIdx] || d.dialogs[0]);
    if (!dialog) { showToast('演示对话缺失'); return; }
    els.btnGenerate.disabled = true;
    els.btnGenerate.textContent = '正在编对话…';
    showLoading('正在编对话…');
    await demoWait(1100);
    hideLoading();
    state.dialog = dialog;
    openDialogModal(dialog);
    renderDialogButton();
    els.btnGenerate.disabled = false;
    showToast('对话生成完成（演示）');
  }

  function exitDemo() {
    if (!state.isDemo) return;
    state.isDemo = false;
    els.demoBadge.hidden = true;
    els.actionbarHint.textContent = '圈出物品并输入中文，就会加入上面的单词表';
  }

  // ---------- 渲染 ----------
  function renderList() {
    els.itemCount.textContent = state.items.length;
    els.btnGenerate.disabled = state.items.length === 0;
    els.wordlistUl.innerHTML = '';

    if (state.items.length === 0) {
      const li = document.createElement('li');
      li.className = 'word-row word-row--empty';
      li.textContent = '圈出照片里的物品，输入中文，就会出现在这里';
      els.wordlistUl.appendChild(li);
    } else {
      state.items.forEach((it, idx) => {
        const li = document.createElement('li');
        li.className = 'word-row';
        li.innerHTML = `
          <div class="word-row__main">
            <div class="word-row__en">${escapeHtml(it.en)}</div>
            <div class="word-row__meta">${escapeHtml(it.phonetic || '')} · ${escapeHtml(it.zh || '')}</div>
          </div>
          <button class="word-row__speak" aria-label="朗读 ${escapeHtml(it.en)}">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M5 9v6h4l5 4V5l-5 4H5z" stroke-linejoin="round" />
              <path d="M16 8a5 5 0 0 1 0 8" stroke-linecap="round" />
            </svg>
          </button>
          <button class="word-row__remove" aria-label="删除 ${escapeHtml(it.en)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
            </svg>
          </button>
        `;
        const speakBtn = li.querySelector('.word-row__speak');
        speakBtn.onclick = () => speak(it.en, speakBtn);
        li.querySelector('.word-row__remove').onclick = () => {
          const [removed] = state.items.splice(idx, 1);
          // 识别错了删词条时，把对应的圈恢复成未确认，用户可以直接重新输入重试
          if (removed && removed.circle) {
            removed.circle.used = false;
            removed.circle.label = '';
            redrawCircles();
          }
          // 单词表变了，之前生成的对话已不再是"今天学的词"的对话，清掉
          state.dialog = null;
          renderList();
        };
        els.wordlistUl.appendChild(li);
      });
    }
    renderDialogButton();
  }

  // ---------- 对话：Modal + 本地存储 ----------
  const SAVED_DIALOG_KEY = '拍学_saved_dialogs';

  function loadSavedDialogs() {
    try {
      const raw = localStorage.getItem(SAVED_DIALOG_KEY);
      state.savedDialogs = raw ? JSON.parse(raw) : [];
    } catch (e) { state.savedDialogs = []; }
  }
  function persistSavedDialogs() {
    try { localStorage.setItem(SAVED_DIALOG_KEY, JSON.stringify(state.savedDialogs)); } catch (e) {}
  }

  // 根据 state.dialog 状态改 btnGenerate 文案：有对话 → "查看对话"；无 → "生成英文对话"
  function renderDialogButton() {
    if (state.items.length === 0) return; // disabled 状态文案不动
    els.btnGenerate.textContent = state.dialog ? '查看对话' : '生成英文对话';
  }

  function renderDialogTurns(turns) {
    return (turns || []).map((t, i) => {
      const isB = (t.speaker || '').toUpperCase() === 'B';
      const hl = (t.highlights || []).map((w) => `<span class="dm-hl">${escapeHtml(w)}</span>`).join('');
      return `
        <div class="dm-turn dm-turn--${isB ? 'b' : 'a'}">
          <span class="dm-turn__who">${escapeHtml(t.speaker || '')}</span>
          <div class="dm-bubble">
            <p class="dm-bubble__en">${escapeHtml(t.en || '')}</p>
            <p class="dm-bubble__zh">${escapeHtml(t.zh || '')}</p>
          </div>
          ${hl ? `<div class="dm-turn__hl">${hl}</div>` : ''}
          <button class="dm-turn__speak" data-idx="${i}" aria-label="朗读">🔊</button>
        </div>
      `;
    }).join('');
  }

  function openDialogModal(dialog) {
    if (!dialog) return;
    els.dialogModalScene.textContent = dialog.scene || '';
    els.dialogModalBody.innerHTML = renderDialogTurns(dialog.turns);
    // 演示模式：让对话一条条浮现，模拟正在生成
    if (state.isDemo) {
      els.dialogModalBody.querySelectorAll('.dm-turn').forEach((el, i) => {
        el.classList.add('dm-turn--demo-in');
        el.style.animationDelay = (i * 160) + 'ms';
      });
    }
    els.dialogModal.querySelectorAll('.dm-turn__speak').forEach((btn) => {
      btn.onclick = () => speak((dialog.turns[Number(btn.dataset.idx)] || {}).en || '', btn);
    });
    els.dialogModalSave.textContent = '保存';
    els.dialogModalSave.disabled = false;
    els.dialogModal.hidden = false;
  }

  function closeDialogModal() { els.dialogModal.hidden = true; }

  // 生词本页面渲染
  function renderVocabPage() {
    const list = state.savedDialogs;
    els.vocabEmpty.hidden = list.length > 0;
    if (list.length === 0) { els.vocabList.innerHTML = ''; return; }
    els.vocabList.innerHTML = list.map((entry, idx) => {
      const d = entry.dialog || {};
      const scene = escapeHtml(d.scene || '对话');
      const words = (entry.itemsUsed || []).slice(0, 6).map((it) => `<span>${escapeHtml(it.en)}</span>`).join('');
      const date = entry.savedAt ? new Date(entry.savedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';
      return `
        <li class="vocab-item" data-idx="${idx}">
          <div class="vocab-item__main">
            <h3 class="vocab-item__scene">${scene}</h3>
            <div class="vocab-item__words">${words}</div>
            <span class="vocab-item__date">${date} · 点击复习</span>
          </div>
          <button class="vocab-item__open" aria-label="打开">›</button>
        </li>
      `;
    }).join('');
    els.vocabList.querySelectorAll('.vocab-item').forEach((li) => {
      li.onclick = () => {
        const entry = state.savedDialogs[Number(li.dataset.idx)];
        if (entry && entry.dialog) openDialogModal(entry.dialog);
      };
    });
  }

  // ---------- 主流程 ----------
  // 拍照 / 选图后不再自动识别整张图，直接进入圈画模式：
  // 由用户圈出想认识的物品并输入中文，再换取英文（见 processZhInput）。
  // append=true 时把新图追加到 photos 末尾、activePhotoIdx 跳到新图，旧图/圈/单词都保留；
  // append=false 时替换掉 photos（即全新一轮）。
  async function handleImageFile(file, append = false) {
    if (!file) return;
    if (state.isDemo) {
      showToast('演示模式用的是示例照片，点「我的」填入 key 就能拍自己的');
      return;
    }
    if (!file.type.startsWith('image/')) { showToast('请选择图片'); return; }
    if (!ensureKey()) return;
    try {
      const raw = await readFileAsDataURL(file);
      const img = await loadImage(raw);
      const compressed = await compressImage(raw);
      const newPhoto = { dataURL: compressed, rawDataURL: raw, ar: img.width + ' / ' + img.height };

      if (append) {
        state.photos.push(newPhoto);
        state.activePhotoIdx = state.photos.length - 1;
        showToast('已添加第 ' + state.photos.length + ' 张图');
      } else {
        state.photos = [newPhoto];
        state.activePhotoIdx = 0;
        state.items = [];
        state.circles = [];
        state.dialog = null;
      }
      state.photoAR = newPhoto.ar;
      renderPhoto();
      renderList();
      updatePhotoCounter();
      switchPage('result');
      if (!state.isCircleMode) enterCircleMode();
    } catch (e) {
      console.error(e);
      showToast('图片读取失败');
    }
  }

  // 把当前 activePhotoIdx 的照片显示到 DOM，自动重算 canvas 并重画圈
  function renderPhoto() {
    const p = state.photos[state.activePhotoIdx];
    if (!p) return;
    els.photoWrap.style.aspectRatio = p.ar;
    els.photoImg.src = p.dataURL;
    state.photoAR = p.ar;
    els.photoImg.onload = () => {
      syncCanvasSize();
      redrawCircles();
    };
  }

  // 切图：上下一张 + 当前图的圈
  function switchPhoto(delta) {
    if (state.photos.length <= 1) return;
    const wasCircle = state.isCircleMode;
    if (wasCircle) exitCircleMode();
    let idx = state.activePhotoIdx + delta;
    if (idx < 0) idx = 0;
    if (idx >= state.photos.length) idx = state.photos.length - 1;
    if (idx === state.activePhotoIdx) return;
    state.activePhotoIdx = idx;
    renderPhoto();
    updatePhotoCounter();
    if (state.isDemo) { state.dialog = null; renderDialogButton(); } // 换图后对话也要跟着换
    if (wasCircle) enterCircleMode();
  }

  // 顶栏小计数器："2 / 5"，显示在"看图学词"标题旁边
  function updatePhotoCounter() {
    const n = state.photos.length;
    const cur = n ? state.activePhotoIdx + 1 : 0;
    if (els.photoCounter) {
      els.photoCounter.textContent = n > 1 ? cur + ' / ' + n : '';
    }
  }

  // ---------- 圈画 ----------
  let drag = null; // { mode: 'new' | 'move' | 'resize', ... }

  // 画布尺寸只能在元素真正可见时量到：页面隐藏时 getBoundingClientRect 返回 0×0，
  // 会把 canvas 的 width/height 也设成 0，导致既画不出来、也点不中（无命中区域）。
  // 所以除了启动和窗口 resize，进入圈画模式时还要再同步一次。
  function syncCanvasSize() {
    const c = els.canvas;
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return; // 页面还没显示，量不到尺寸
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawCircles();
  }

  function setupCanvas() {
    syncCanvasSize();
    window.addEventListener('resize', onViewportResize);
    // iOS 弹键盘不改 window 尺寸但会改 visualViewport，照片要跟着重算；
    // 部分国产内核键盘弹出时只触发 scroll（平推）不触发 resize，也监听上。
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onViewportResize);
      window.visualViewport.addEventListener('scroll', onViewportResize);
    }
    // 照片 src 是异步解码的：解码完成后若在圈画模式，重新适配一次布局
    els.photoImg.addEventListener('load', () => {
      if (state.isCircleMode) fitCircleLayout();
    });
  }

  function onViewportResize() {
    // 圈画模式下高度变化基本都是键盘引起的：只做 transform 缩放（有动画），
    // 不重排布局尺寸，避免和键盘动画打架造成多步跳动。
    if (state.isCircleMode) {
      lockPageScroll(); // 抵消浏览器「推页面上移露出输入框」的动作
      applyPhotoShrink();
    } else {
      syncCanvasSize();
    }
  }

  const HANDLE = 12;      // 四角手柄边长（CSS px）
  const HIT_PAD = 16;     // 手柄命中范围
  const MIN_SIZE = 0.015; // 圈的最小尺寸，防误触（原来 0.04 太大，轻轻一划就被丢掉）

  function circleCorners(c) {
    return [
      { n: 'nw', x: c.x1, y: c.y1 },
      { n: 'ne', x: c.x2, y: c.y1 },
      { n: 'sw', x: c.x1, y: c.y2 },
      { n: 'se', x: c.x2, y: c.y2 },
    ];
  }

  function redrawCircles() {
    const cvs = els.canvas;
    const r = cvs.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const ctx = cvs.getContext('2d');
    ctx.clearRect(0, 0, r.width, r.height);

    const activeIdx = state.activePhotoIdx;
    const visible = state.circles.filter((c) => c.photoIdx === activeIdx);
    const withCurrent = state.currentCircle && state.currentCircle.photoIdx === activeIdx
      ? visible.concat([state.currentCircle]) : visible;

    withCurrent.forEach((c) => {
      const x = c.x1 * r.width, y = c.y1 * r.height;
      const w = (c.x2 - c.x1) * r.width, h = (c.y2 - c.y1) * r.height;

      ctx.setLineDash(c.used ? [] : [8, 4]);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = c.used ? '#1ec47a' : '#E3F04B';
      ctx.strokeRect(x, y, w, h);

      if (c.used && c.label) {
        ctx.setLineDash([]);
        ctx.font = '600 13px -apple-system, "PingFang SC", sans-serif';
        const tw = Math.ceil(ctx.measureText(c.label).width);
        const by = y - 22 >= 0 ? y - 22 : y + h + 4;
        ctx.fillStyle = '#141414';
        ctx.fillRect(x, by, tw + 12, 18);
        ctx.fillStyle = '#E3F04B';
        ctx.fillText(c.label, x + 6, by + 13);
      }
    });

    if (state.isCircleMode) {
      visible.forEach((c) => {
        circleCorners(c).forEach((pt) => {
          const px = pt.x * r.width, py = pt.y * r.height;
          ctx.setLineDash([]);
          ctx.fillStyle = '#FAF8F3';
          ctx.strokeStyle = '#141414';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.rect(px - HANDLE / 2, py - HANDLE / 2, HANDLE, HANDLE);
          ctx.fill();
          ctx.stroke();
        });
      });
    }
  }

  // 进入圈画模式时把照片精确缩放到「顶条和输入条之间」，保持原图宽高比。
  // 基准尺寸只在进入时算一次；之后键盘弹出/收起只做 transform 缩放（见 applyPhotoShrink）。
  // 宽高用显式像素而不是 aspect-ratio，是为了让 canvas 归一化坐标和照片严格 1:1。
  function fitCircleLayout() {
    const img = els.photoImg;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const topH = els.circleMaskTop.offsetHeight || 0;
    const barH = els.circleMaskBar.offsetHeight || 0;
    const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const availW = vw - 24;               // 页面左右各留 12px
    const availH = vh - topH - barH - 16; // 上下各留 8px 缝
    const ar = img.naturalWidth / img.naturalHeight;
    let w = availW, h = w / ar;
    if (h > availH) { h = availH; w = h * ar; }
    const wrap = els.photoWrap;
    wrap.style.transform = '';            // 先清掉键盘缩放，基准尺寸永远按全屏算
    wrap.style.width = Math.round(w) + 'px';
    wrap.style.height = Math.round(h) + 'px';
    wrap.style.margin = '';               // 圈画模式下照片 fixed 定位，居中由 CSS+transform 负责
    wrap.style.aspectRatio = 'auto';        // 显式尺寸优先，避免和 aspect-ratio 打架
    state.circleBaseH = Math.round(h);      // 键盘缩放以它为基准
    // 输入条滑到顶部需要的终点位置 = 100% - 输入条高度
    document.documentElement.style.setProperty(
      '--circle-bar-h', els.circleMaskBar.offsetHeight + 'px');
    syncCanvasSize();
    applyPhotoShrink();
  }

  // 键盘态（body.circle-keyboard）：输入条已滑到屏幕顶部，照片排在它下面。
  // 缩放比例：优先相信 visualViewport 报的可视高度；浏览器不报告键盘时
  // （部分国产内核只平推页面、不改任何高度）s=1，照片保持原尺寸，
  // 顶部和所圈区域不会被推出屏幕，仅下半部分被键盘盖住。
  function applyPhotoShrink() {
    if (!state.isCircleMode) return;
    const wrap = els.photoWrap;
    const baseH = state.circleBaseH || wrap.offsetHeight;
    if (!baseH) return;
    const kb = document.body.classList.contains('circle-keyboard');
    const topH = kb
      ? (els.circleMaskBar.offsetHeight || 0)  // 键盘态：输入条在顶部
      : (els.circleMaskTop.offsetHeight || 0); // 普通态：提示条在顶部
    const bottomH = kb ? 0 : (els.circleMaskBar.offsetHeight || 0);
    const vv = window.visualViewport;
    const vh = vv ? vv.height : window.innerHeight;
    const availH = vh - topH - bottomH - 16;
    const s = Math.min(1, availH / baseH);
    wrap.style.top = (topH + 8) + 'px';
    wrap.style.transformOrigin = 'top center';
    wrap.style.transform = 'translateX(-50%)' + (s < 0.999 ? ' scale(' + s.toFixed(3) + ')' : '');
  }

  // 不支持 interactive-widget=resizes-content 的浏览器（如部分国产定制浏览器），
  // 键盘弹出时会把整个页面往上推来露出输入框——照片会被顶出屏幕外再回落。
  // 强制把滚动位置锁回顶部，抵消这一下推移。
  function lockPageScroll() {
    window.scrollTo(0, 0);
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  }

  function enterCircleMode() {
    if (!ensureKey()) return;
    state.isCircleMode = true;
    document.body.classList.add('circle-mode'); // 锁屏：藏顶栏/单词表/底部按钮，只留照片和蒙层
    els.canvas.classList.add('circle-canvas--active');
    els.circleMask.hidden = false; // 先显示蒙层，fitCircleLayout 才量得到顶/底条高度
    els.canvas.style.zIndex = '5';
    els.inputZh.value = '';
    syncAddBtn(); // 输入清空后按钮显示「识别」
    // 状态行在圈画模式下是隐藏的，引导语统一走蒙层顶条的 tip
    els.circleMaskTip.textContent = state.circles.length
      ? '拖动框或拉四角调整，拖空白处再圈一个'
      : '拖框圈住物品：输中文得英文，留空点「识别」';
    fitCircleLayout();
  }

  function exitCircleMode() {
    state.isCircleMode = false;
    state.currentCircle = null;
    document.body.classList.remove('circle-mode');
    document.body.classList.remove('circle-keyboard');
    els.canvas.classList.remove('circle-canvas--active');
    els.circleMask.hidden = true;
    els.canvas.style.zIndex = '';
    // 照片还原成文档流里的全宽显示（按原图比例）
    const wrap = els.photoWrap;
    wrap.style.transform = '';
    wrap.style.top = '';
    wrap.style.width = '';
    wrap.style.height = '';
    wrap.style.margin = '';
    wrap.style.aspectRatio = state.photoAR || '';
    state.circleBaseH = null;
    syncCanvasSize(); // 尺寸变了，重量画布并重画圈
  }

  // 手势命中：四角手柄 > 圈内部 > 空白。只命中当前 active 图的圈。
  function hitTest(clientX, clientY) {
    const r = els.canvas.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    const activeIdx = state.activePhotoIdx;
    for (let i = state.circles.length - 1; i >= 0; i--) {
      if (state.circles[i].photoIdx !== activeIdx) continue;
      const cs = circleCorners(state.circles[i]);
      for (let k = 0; k < cs.length; k++) {
        if (Math.abs(px - cs[k].x * r.width) <= HIT_PAD &&
            Math.abs(py - cs[k].y * r.height) <= HIT_PAD) {
          return { type: 'resize', idx: i, corner: cs[k].n };
        }
      }
    }
    for (let i = state.circles.length - 1; i >= 0; i--) {
      if (state.circles[i].photoIdx !== activeIdx) continue;
      const c = state.circles[i];
      if (px >= c.x1 * r.width && px <= c.x2 * r.width &&
          py >= c.y1 * r.height && py <= c.y2 * r.height) {
        return { type: 'move', idx: i };
      }
    }
    return null;
  }

  els.canvas.addEventListener('pointerdown', (e) => {
    if (!state.isCircleMode) return;
    e.preventDefault();
    if (els.canvas.setPointerCapture) {
      try { els.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    }

    const r = els.canvas.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width;
    const ny = (e.clientY - r.top) / r.height;
    const hit = hitTest(e.clientX, e.clientY);

    if (hit) {
      const c = state.circles[hit.idx];
      if (hit.type === 'resize') {
        // 对角固定不动，拖的那角跟着走
        drag = {
          mode: 'resize',
          idx: hit.idx,
          fixed: {
            x: (hit.corner === 'nw' || hit.corner === 'sw') ? c.x2 : c.x1,
            y: (hit.corner === 'nw' || hit.corner === 'ne') ? c.y2 : c.y1,
          },
        };
      } else {
        drag = {
          mode: 'move', idx: hit.idx,
          offX: nx - c.x1, offY: ny - c.y1,
          w: c.x2 - c.x1, h: c.y2 - c.y1,
        };
      }
      return;
    }

    drag = { mode: 'new', sx: nx, sy: ny };
    state.currentCircle = { x1: nx, y1: ny, x2: nx, y2: ny, photoIdx: state.activePhotoIdx };
  });

  els.canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = els.canvas.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));

    if (drag.mode === 'new') {
      state.currentCircle = {
        x1: Math.min(drag.sx, nx), y1: Math.min(drag.sy, ny),
        x2: Math.max(drag.sx, nx), y2: Math.max(drag.sy, ny),
        photoIdx: state.activePhotoIdx,
      };
    } else if (drag.mode === 'move') {
      const c = state.circles[drag.idx];
      const x1 = Math.max(0, Math.min(1 - drag.w, nx - drag.offX));
      const y1 = Math.max(0, Math.min(1 - drag.h, ny - drag.offY));
      c.x1 = x1; c.y1 = y1; c.x2 = x1 + drag.w; c.y2 = y1 + drag.h;
    } else {
      const c = state.circles[drag.idx], f = drag.fixed;
      c.x1 = Math.min(f.x, nx); c.x2 = Math.max(f.x, nx);
      c.y1 = Math.min(f.y, ny); c.y2 = Math.max(f.y, ny);
    }
    redrawCircles();
  });

  els.canvas.addEventListener('pointerup', () => {
    if (!drag) return;
    const mode = drag.mode;
    drag = null;

    if (mode !== 'new') { redrawCircles(); return; } // 移动/缩放完成，留在圈画模式

    const c = state.currentCircle;
    state.currentCircle = null;
    if (c && (c.x2 - c.x1) >= MIN_SIZE && (c.y2 - c.y1) >= MIN_SIZE) {
      c.used = false;
      c.label = '';
      c.photoIdx = state.activePhotoIdx;
      state.circles.push(c);
      redrawCircles();
      // 关键：画完**不退出**圈画模式，框留在图上、手柄还在，先让用户看清和调整。
      // 也不自动弹键盘（键盘会挡住照片），用户自己点输入框。
      els.circleMaskTip.textContent = '框好了：输中文点「加入」，或直接点「识别」识图';
    } else {
      redrawCircles();
    }
  });

  els.canvas.addEventListener('pointercancel', () => {
    drag = null;
    state.currentCircle = null;
    redrawCircles();
  });

  // 撤销：去掉当前 active 图上最后一个圈（若它已经出过词，词仍留在单词表里）
  els.btnCircleUndo.onclick = () => {
    for (let i = state.circles.length - 1; i >= 0; i--) {
      if (state.circles[i].photoIdx === state.activePhotoIdx) {
        state.circles.splice(i, 1);
        break;
      }
    }
    redrawCircles();
  };
  els.btnCircleDone.onclick = () => {
    const pending = state.circles.filter((c) => c.photoIdx === state.activePhotoIdx && !c.used).length;
    exitCircleMode();
    els.status.textContent = pending
      ? '有 ' + pending + ' 个圈还没出词（想补就再点「再圈一个词」）'
      : '圈完了，点「再圈一个词」继续';
  };

  // ---------- 底部输入条（两种模式） ----------
  // 输中文 → 「加入」：词典 / 纯文本查词，不发图，省 token
  // 留空   → 「识别」：把圈选区域发给豆包看图识物（不知道物品名时用）
  function syncAddBtn() {
    els.btnAddZh.textContent = els.inputZh.value.trim() ? '加入' : '识别';
  }

  async function submitZh() {
    await processInput(els.inputZh.value.trim());
  }

  els.btnAddZh.onclick = submitZh;
  els.inputZh.addEventListener('input', syncAddBtn);
  els.inputZh.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    await submitZh();
  });
  // 键盘弹出/收起：focus 时立即给 body 加 circle-keyboard ——
  // 输入条在键盘开始动画前就已位于屏幕顶部，浏览器无需平推页面；
  // blur 时移除，输入条滑回底部。visualViewport 的 resize/scroll
  // 事件（setupCanvas 里注册）负责在能拿到键盘高度的浏览器上等比缩小照片。
  els.inputZh.addEventListener('focus', () => {
    if (!state.isCircleMode) return;
    document.body.classList.add('circle-keyboard');
    lockPageScroll();
    applyPhotoShrink();
    setTimeout(applyPhotoShrink, 260); // 键盘动画结束后，可视高度才最终稳定
  });
  els.inputZh.addEventListener('blur', () => {
    if (!state.isCircleMode) return;
    document.body.classList.remove('circle-keyboard');
    applyPhotoShrink();
    setTimeout(applyPhotoShrink, 260);
  });

  // 主入口：有中文 → 直译（词典/纯文本）；空输入 → 识图（发圈选区域）
  async function processInput(zh) {
    // 最近一个还没命中的圈（当前 active 图上的）= 这笔输入对应的目标
    let target = null;
    for (let i = state.circles.length - 1; i >= 0; i--) {
      if (state.circles[i].photoIdx !== state.activePhotoIdx) continue;
      if (!state.circles[i].used) { target = state.circles[i]; break; }
    }
    const settle = (en) => {
      if (target) { target.used = true; target.label = en; }
      els.inputZh.value = '';
      syncAddBtn();
      els.inputZh.blur(); // 收键盘，让照片重新露出来
      // 圈画模式下状态行是隐藏的，「已加入」反馈打到蒙层顶条上
      if (state.isCircleMode) {
        els.circleMaskTip.textContent = '已加入：' + en + '。继续圈，或点「完成」';
      }
      redrawCircles();
    };

    // 演示模式：只查预置词库、只认预置物品，不请求接口
    if (state.isDemo) {
      await demoProcessInput(zh, target, settle);
      return;
    }

    console.log('[拍拍学] 输入中文 =', zh || '（空，识图模式）',
      '| 目标圈 =', target,
      '| 内置词典命中 =', zh ? !!DICT[zh.trim()] : false,
      '| key =', getKey() ? '已配置' : '缺失');

    if (zh) {
      // ===== 直译模式：本地词典 → 纯文本查词，全程不发图 =====
      const local = lookupLocal(zh);
      if (local) {
        addItem({ en: local.en, zh: local.zh, phonetic: local.phonetic }, target);
        els.status.textContent = `已加入：${local.en}（内置词典）`;
        settle(local.en);
        return;
      }
      showLoading('正在查词…');
      try {
        const ai = await callDoubaoLookup(zh);
        if (!ai) {
          els.status.textContent = `没找到「${zh}」的英文，换个说法试试`;
          showToast('没找到这个词，换个说法试试');
          return;
        }
        addItem(ai, target);
        els.status.textContent = `已加入：${ai.en}`;
        settle(ai.en);
      } catch (e) {
        console.error(e);
        const msg = (e && e.message) ? e.message : '未知错误';
        els.status.textContent = '查词失败：' + msg;
        showToast('查词失败：' + msg);
        handleDoubaoError(msg);
      } finally {
        hideLoading();
      }
      return;
    }

    // ===== 识图模式：输入为空，必须有圈 =====
    if (!target) {
      showToast('先在照片上圈一个物品，或直接输入中文');
      return;
    }
    showLoading('正在识别这一块…');
    try {
      const curPhoto = state.photos[state.activePhotoIdx];
      const cropped = await cropImageRegion(curPhoto.rawDataURL || curPhoto.dataURL, target);
      console.log('[拍拍学] 裁图完成，dataURL 长度 =', cropped.length);
      const recItems = await callDoubaoVisionRegion(cropped);
      console.log('[拍拍学] 视觉返回 =', recItems);
      const it = recItems.find((x) => x.en);
      if (it) {
        addItem({ en: it.en, zh: it.zh || '', phonetic: it.phonetic || '' }, target);
        els.status.textContent = `已加入：${it.en}`;
        settle(it.en);
        return;
      }
      showToast('没认出这是什么，换个圈法再试');
    } catch (e) {
      console.error(e);
      const msg = (e && e.message) ? e.message : '未知错误';
      showToast('识别失败：' + msg);
      handleDoubaoError(msg);
    } finally {
      hideLoading();
    }
  }

  function addItem(it, circle) {
    if (state.items.find((x) => x.en && x.en.toLowerCase() === it.en.toLowerCase())) {
      els.status.textContent = `${it.en} 已在列表中`;
      return;
    }
    if (circle) it.circle = circle; // 记住词条对应的圈，删除时好把它恢复成未确认
    state.items.push(it);
    renderList();
  }

  // ---------- 事件 ----------
  let pendingAppend = false; // 结果页点「继续拍」打开相机/相册时设 true，表示 append 到现有 photos
  // 演示模式下不允许打开系统选择器：示例照片之外的照片都需要 key 才能识别
  function pickPhoto(input) {
    if (state.isDemo) {
      showToast('演示模式用的是示例照片，点「我的」填入 key 就能拍自己的');
      return;
    }
    input.click();
  }
  els.btnCamera.onclick = () => pickPhoto(els.fileCamera);
  els.btnAlbum.onclick = () => pickPhoto(els.fileAlbum);
  els.fileCamera.onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleImageFile(f, pendingAppend);
    pendingAppend = false;
    e.target.value = '';
  };
  els.fileAlbum.onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleImageFile(f, pendingAppend);
    pendingAppend = false;
    e.target.value = '';
  };

  els.btnBack.onclick = () => {
    // 结果页有照片、用户回首页不主动清——下次重新拍/选图会自动覆盖。
    // 但直接清空一次更干净，让首页像新启动一样。这里保持"不自动清"：
    // 用户想清可以点结果页顶栏的「清空」。
    switchPage('home');
  };

  // 顶栏「继续拍」：追加新图到 photos 末尾
  els.btnAddPhoto.onclick = () => {
    if (state.isDemo) { showToast('演示模式用的是示例照片，填 key 后可拍自己的'); return; }
    if (!state.photos.length) { showToast('先拍一张图'); return; }
    pendingAppend = true;
    els.fileAlbum.click();
  };

  // 非圈画模式下在照片上左右滑切换：手指快速左滑 = 下一张，右滑 = 上一张
  // 圈画模式下 photo-wrap 被 body.circle-mode 隐藏了，手势不会触发
  // 用 preventDefault() 阻止浏览器默认横向滚，只让纵向滚生效
  (function swipePhoto() {
    let sx = 0, sy = 0, active = false, moved = false;
    els.photoWrap.addEventListener('touchstart', (e) => {
      if (state.isCircleMode) return;
      if (state.photos.length <= 1) return;
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY; active = true; moved = false;
    }, { passive: true });
    els.photoWrap.addEventListener('touchmove', (e) => {
      if (!active) return;
      const t = e.touches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      // 只要明显是横向移动就阻止浏览器默认横向滚（但允许纵向）
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) && e.cancelable) {
        e.preventDefault();
        moved = true;
      }
    }, { passive: false });
    els.photoWrap.addEventListener('touchend', (e) => {
      if (!active) return;
      active = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        switchPhoto(dx < 0 ? 1 : -1);
      }
    }, { passive: true });
  })();
  els.btnCircle.onclick = enterCircleMode;
  els.btnDemo.onclick = startDemo;
  els.btnGenerate.onclick = async () => {
    if (state.items.length === 0) { showToast('先圈几个物品加入单词表'); return; }
    if (state.isDemo) { await generateDemoDialog(); return; }
    if (!ensureKey()) return;
    // 已有对话 → 直接弹 modal
    if (state.dialog) { openDialogModal(state.dialog); return; }
    // 第一次生成
    els.btnGenerate.disabled = true;
    els.btnGenerate.textContent = '正在编对话…';
    try {
      const dialog = await callDoubaoDialog(state.items);
      state.dialog = dialog;
      renderDialogButton();
      openDialogModal(dialog);
      showToast('对话生成完成');
    } catch (e) {
      const msg = (e && e.message) || '未知错误';
      showToast('对话生成失败：' + msg);
      handleDoubaoError(msg);
      renderDialogButton();
    } finally {
      els.btnGenerate.disabled = false;
    }
  };

  // 首页齿轮入口已移除，设置统一从底部 tab「我的」进入（见 tab-settings）
  els.btnSettingsTest.onclick = testConnection;
  els.btnFetchModels.onclick = fetchModels;

  // 模型可以手填（从方舟控制台复制），也可以从「拉取可用模型」的候选里挑
  els.inputVisionModel.onchange = () => {
    const v = els.inputVisionModel.value.trim();
    if (v) localStorage.setItem('doubao_vision_model', v);
    syncModelUI();
  };
  els.inputTextModel.onchange = () => {
    const v = els.inputTextModel.value.trim();
    if (v) localStorage.setItem('doubao_text_model', v);
    syncModelUI();
  };
  els.btnSettingsBack.onclick = () => switchPage('home');
  els.btnSettingsSave.onclick = () => {
    const v = els.inputApiKey.value.trim();
    if (!v) { showToast('请输入 key'); return; }
    const wasDemo = state.isDemo;
    setKey(v);
    exitDemo(); // 存了 key 就离开演示模式，改用真实识别
    showToast(wasDemo ? '已保存，现在可以拍自己的照片了' : '已保存');
    els.keyStatus.textContent = '✓ 已配置';
    els.inputKeyHint.textContent = '已配置（不会显示完整 key）。如需更换请直接覆盖。';
    setTimeout(() => switchPage('home'), 600);
  };
  els.btnSettingsClear.onclick = () => {
    if (!confirm('确定清除 key？下次使用需重新填写。')) return;
    setKey('');
    els.inputApiKey.value = '';
    els.keyStatus.textContent = '未配置';
    els.inputKeyHint.textContent = '首次使用需填入你的豆包 API key。key 只存在你自己浏览器。';
    showToast('已清除');
  };

  // 底部 Tab 导航
  els.tabHome.onclick = () => switchPage('home');
  els.tabVocab.onclick = () => switchPage('vocab');
  els.tabSettings.onclick = () => showSettings(false);

  // 对话 modal 事件
  els.dialogModalClose.onclick = closeDialogModal;
  els.dialogModal.querySelector('.dialog-modal__backdrop').onclick = closeDialogModal;
  els.dialogModalSave.onclick = () => {
    if (!state.dialog) return;
    const entry = {
      dialog: state.dialog,
      itemsUsed: state.items.map((it) => ({ en: it.en, zh: it.zh })),
      savedAt: Date.now(),
    };
    // 去重：同场景同词不重复存
    const exists = state.savedDialogs.find((e) =>
      (e.dialog.scene || '') === entry.dialog.scene &&
      (e.itemsUsed.length === entry.itemsUsed.length) &&
      e.itemsUsed.every((x, i) => x.en === entry.itemsUsed[i].en)
    );
    if (exists) { showToast('这段对话之前已经保存过啦'); closeDialogModal(); return; }
    state.savedDialogs.unshift(entry);
    persistSavedDialogs();
    showToast('已保存到生词本');
    els.dialogModalSave.textContent = '已保存 ✓';
    els.dialogModalSave.disabled = true;
  };

  // ---------- 启动 ----------
  loadDict().then(() => {
    setupCanvas();
    warmVoices();
    loadSavedDialogs();
    renderList();
    syncModelUI();
    els.buildTag.textContent = BUILD_TAG;
    // 首次打开不再强弹设置页：没有 key 可以先点首页的「免 key 体验」看效果，
    // 真要用自己的照片时（圈画 / 生成对话）再引导去填 key。
  });

  // ---------- PWA：Service Worker 注册 ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 注册失败', e));
    });
  }
})();
