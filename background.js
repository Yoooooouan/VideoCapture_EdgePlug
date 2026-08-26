/**
 * background.js — MV3 Service Worker
 * 核心逻辑：网络拦截、M3U8 解析、B站 playinfo 提取、下载任务派发
 * 下载执行已迁至 offscreen 常驻文档（后台下载引擎），SW 只组装任务参数并转发，
 * 自身被闲置回收不影响进行中的下载。
 */

// ==================== 常量 ====================

const BILIBILI_QUALITY_MAP = {
  127: '4K 超高清', 120: '4K 超高清', 116: '1080P 60帧',
  112: '1080P+ 高码率', 80: '1080P 高清', 74: '720P 60帧',
  64: '720P', 48: '540P', 32: '480P', 16: '360P', 6: '240P',
};
const BILIBILI_AUDIO_MAP = {
  30251: 'Hi-Res 无损', 30280: '192K', 30232: '132K', 30216: '64K',
};
const MEDIA_EXT_RE = /\.(m3u8|mp4|m4s|flv|ts|m4a|aac|mp3|wav|flac|webm|ogg)(\?|#|$)/i;
const BILIBILI_CDN_RE = /bilivideo\.(com|cn)|akamaized\.net|szbdos\.com/i;
const DOUYIN_CDN_RE = /douyinvod\.com|douyin\.com|bytecdn/i;

// ==================== 下载大小预估 ====================
// 音频目标格式对应的码率（bps）。FLAC 当前实现实为 WAV 编码，按 WAV 计。
const AUDIO_FORMAT_BITRATE = {
  'mp3-320': 320000,
  'mp3-192': 192000,
  'mp3-128': 128000,
  'wav': 1411200,   // 16-bit PCM @ 44.1kHz × 2 声道 ≈ 1411.2 kbps
  'flac': 1411200,  // 当前实现 FLAC 实为 WAV 编码，按 WAV 计
};
const MERGE_AUDIO_BITRATE = 192000; // offscreen MediaRecorder 的 audioBitsPerSecond（合并音频固定值）

function formatBytes(n) {
  if (n === null || n === undefined || isNaN(n)) return '未知';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// 基于码率(bps)与时长(s)预估下载字节数
// mode: 'video' | 'audio' | 'merge'
function estimateMediaSize(media, { mode, qualityIndex = 0, audioFormat = 'mp3-320' }) {
  const duration = media.duration || 0;
  const qOpts = media.qualityOptions || [];
  const vQ = qOpts[qualityIndex] || qOpts[0];
  const vBps = vQ ? (vQ.bandwidth || 0) : 0;                       // 选中清晰度的视频码率
  const fmtBps = AUDIO_FORMAT_BITRATE[audioFormat] || 192000;      // 目标音频格式码率

  let totalBps = 0;
  if (mode === 'video') totalBps = vBps;                          // 仅视频：所选清晰度码率
  else if (mode === 'audio') totalBps = fmtBps;                   // 仅音频：大小取决于所选格式
  else if (mode === 'merge') totalBps = vBps + MERGE_AUDIO_BITRATE; // 合并：视频源码率 + 192k 音频

  const bytes = duration > 0 ? (totalBps / 8) * duration : null;
  const perMinute = totalBps > 0 ? (totalBps / 8) * 60 : null;
  return { bytes, perMinute, hasDuration: duration > 0, totalBps, vBps, fmtBps };
}

// ==================== Tab 状态管理 ====================

const tabStates = new Map();

// 下载进度现在由 offscreen 引擎直接广播（DOWNLOAD_PROGRESS），
// SW 不再持有下载上下文，被闲置回收也不影响任务。

function getTabState(tabId) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      mediaList: [],
      mediaUrlSet: new Set(), // 去重
      title: '',
      playinfo: null,
      site: 'general',
      url: '',
      downloadProgress: null,
    });
  }
  return tabStates.get(tabId);
}

function clearTabState(tabId) {
  const state = tabStates.get(tabId);
  if (state) {
    state.mediaList = [];
    state.mediaUrlSet = new Set();
    state.playinfo = null;
    state.title = '';
    state.site = 'general';
    state.downloadProgress = null;
  }
}

// 按 mediaId 查找媒体与其所属 state：
// 优先在指定 tab（或 URL 扫描结果的虚拟 key "scan_<tabId>"）中查找，
// 找不到时全局兜底——扫描结果标签页已关闭，state 挂在虚拟 key 上。
function findMediaAndState(mediaId, preferTabId) {
  if (preferTabId !== undefined && preferTabId !== null) {
    const st = tabStates.get(preferTabId);
    const m = st?.mediaList?.find(x => x.id === mediaId);
    if (m) return { media: m, state: st };
  }
  for (const st of tabStates.values()) {
    const m = st.mediaList?.find(x => x.id === mediaId);
    if (m) return { media: m, state: st };
  }
  return null;
}

// ==================== 网络请求拦截 ====================

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return; // 非页面请求

    const url = details.url;
    const tabId = details.tabId;

    // 判断是否为媒体 URL
    let isMedia = false;
    let mediaType = 'unknown';

    if (MEDIA_EXT_RE.test(url)) {
      isMedia = true;
      const ext = url.match(MEDIA_EXT_RE)[1].toLowerCase();
      if (ext === 'm3u8') mediaType = 'hls';
      else if (ext === 'mp4' || ext === 'webm' || ext === 'flv') mediaType = 'video';
      else if (ext === 'm4s') mediaType = 'dash';
      else if (['m4a', 'aac', 'mp3', 'wav', 'flac', 'ogg'].includes(ext)) mediaType = 'audio';
      else if (ext === 'ts') return; // TS 分段单独不记录，通过 m3u8 处理
    }

    // B站 CDN 域名也作为媒体
    if (!isMedia && BILIBILI_CDN_RE.test(url) && url.includes('.m4s')) {
      isMedia = true;
      mediaType = 'dash';
    }

    // 抖音 CDN
    if (!isMedia && DOUYIN_CDN_RE.test(url) && /\.(mp4|flv)(\?|#|$)/i.test(url)) {
      isMedia = true;
      mediaType = 'video';
    }

    if (!isMedia) return;

    const state = getTabState(tabId);

    // 去重
    if (state.mediaUrlSet.has(url)) return;
    state.mediaUrlSet.add(url);

    // 添加到媒体列表
    const mediaItem = {
      id: `net_${tabId}_${Date.now()}_${state.mediaList.length}`,
      url: url,
      type: mediaType,
      title: state.title || '未命名视频',
      format: url.match(MEDIA_EXT_RE)?.[1]?.toLowerCase() || '',
      duration: 0,
      poster: '',
      detectedAt: Date.now(),
      source: 'network',
      qualityOptions: [],
      selectedQuality: 0,
    };

    // 对于 HLS，异步获取清晰度选项
    if (mediaType === 'hls') {
      mediaItem.qualityOptions = [{ label: '默认', bandwidth: 0 }];
      fetchHLSVariants(url).then((variants) => {
        if (variants && variants.length > 0) {
          mediaItem.qualityOptions = variants.map((v, i) => ({
            label: v.resolution || `${Math.round(v.bandwidth / 1000)}kbps`,
            bandwidth: v.bandwidth,
            url: v.url,
            index: i,
          }));
        }
      }).catch(() => {});
    }

    state.mediaList.push(mediaItem);
  },
  { urls: ['<all_urls>'] }
);

// ==================== Tab 导航处理（切换网页后刷新） ====================

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || (changeInfo.status === 'loading' && changeInfo.url)) {
    // 页面导航 → 清空状态
    clearTabState(tabId);
    const state = getTabState(tabId);
    state.url = changeInfo.url || tab.url || '';
    // 判断站点类型
    if (state.url.includes('bilibili.com')) state.site = 'bilibili';
    else if (state.url.includes('douyin.com')) state.site = 'douyin';
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
});

// ==================== B站 playinfo 提取 ====================

async function getBilibiliPlayinfo(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        // 尝试 __playinfo__
        if (window.__playinfo__ && window.__playinfo__.data && window.__playinfo__.data.dash) {
          const dash = window.__playinfo__.data.dash;
          return {
            type: 'dash',
            video: (dash.video || []).map(v => ({
              id: v.id,
              baseUrl: v.baseUrl || v.base_url || '',
              backupUrl: (v.backupUrl || v.backup_url || [])[0] || '',
              codecs: v.codecs || v.codec_code || '',
              bandwidth: v.bandwidth || 0,
              width: v.width || 0,
              height: v.height || 0,
            })),
            audio: (dash.audio || []).map(a => ({
              id: a.id,
              baseUrl: a.baseUrl || a.base_url || '',
              backupUrl: (a.backupUrl || a.backup_url || [])[0] || '',
              codecs: a.codecs || a.codec_code || '',
              bandwidth: a.bandwidth || 0,
            })),
            duration: dash.duration || 0,
          };
        }

        // 尝试 __INITIAL_STATE__ 获取 bvid/cid
        if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.videoData) {
          return {
            type: 'initial_state',
            bvid: window.__INITIAL_STATE__.videoData.bvid,
            cid: window.__INITIAL_STATE__.videoData.cid,
            aid: window.__INITIAL_STATE__.videoData.aid,
            title: window.__INITIAL_STATE__.videoData.title,
          };
        }

        return null;
      },
    });

    const result = results?.[0]?.result;
    if (!result) return null;

    if (result.type === 'dash') {
      return result;
    }

    if (result.type === 'initial_state') {
      // 通过 API 获取 playinfo
      const apiUrl = `https://api.bilibili.com/x/player/playurl?bvid=${result.bvid}&cid=${result.cid}&fnval=80&fnver=0&qn=127`;
      const resp = await fetch(apiUrl);
      const json = await resp.json();
      if (json.code === 0 && json.data && json.data.dash) {
        const dash = json.data.dash;
        return {
          type: 'dash',
          video: (dash.video || []).map(v => ({
            id: v.id,
            baseUrl: v.baseUrl || v.base_url || '',
            backupUrl: (v.backupUrl || v.backup_url || [])[0] || '',
            codecs: v.codecs || v.codec_code || '',
            bandwidth: v.bandwidth || 0,
            width: v.width || 0,
            height: v.height || 0,
          })),
          audio: (dash.audio || []).map(a => ({
            id: a.id,
            baseUrl: a.baseUrl || a.base_url || '',
            backupUrl: (a.backupUrl || a.backup_url || [])[0] || '',
            codecs: a.codecs || a.codec_code || '',
            bandwidth: a.bandwidth || 0,
          })),
          duration: dash.duration || 0,
          title: result.title,
        };
      }
    }

    return null;
  } catch (e) {
    console.error('[VC] B站 playinfo 提取失败:', e);
    return null;
  }
}

function buildBilibiliMediaList(playinfo, title) {
  const list = [];

  // 视频流
  // B站 playinfo 的 dash.video 同一清晰度(qn)会返回多个编码版本
  // （H.264 avc1 / H.265 hev1 / AV1 av01）。Chrome 的 <video> 不解 HEVC/AV1，
  // 直接默认选最高码率 → 选到 HEVC → "视频解码失败（格式不支持）"。
  // 处理：同一 qn 只保留 1 路，优先 H.264；label 标注 codec；默认选第一个可解码的。
  const codecRank = (codecs) => {
    const c = (codecs || '').toLowerCase();
    if (c.includes('avc1') || c.includes('avc3')) return 0; // H.264（Chrome 必解）
    if (c.includes('hev1') || c.includes('hvc1')) return 1; // H.265（多数 Chrome 解不了）
    if (c.includes('av01')) return 2;                       // AV1（部分 Chrome 解不了）
    return 3;
  };
  const codecName = (codecs) => {
    const r = codecRank(codecs);
    return r === 0 ? 'H.264' : r === 1 ? 'H.265' : r === 2 ? 'AV1' : '未知';
  };

  if (playinfo.video && playinfo.video.length > 0) {
    // 1) 按 qn 分组
    const byQn = new Map();
    for (const v of playinfo.video) {
      if (!byQn.has(v.id)) byQn.set(v.id, []);
      byQn.get(v.id).push(v);
    }
    // 2) 同一 qn 优先保留 H.264
    const deduped = [];
    for (const group of byQn.values()) {
      group.sort((a, b) => codecRank(a.codecs) - codecRank(b.codecs));
      deduped.push(group[0]);
    }
    // 3) 按 qn 降序（高清晰度在前）
    const videoSorted = deduped.sort((a, b) => b.id - a.id);

    const qualityOptions = videoSorted.map((v, i) => ({
      label: `${BILIBILI_QUALITY_MAP[v.id] || `${v.height}p` || `流${i + 1}`} (${codecName(v.codecs)})`,
      bandwidth: v.bandwidth,
      url: v.baseUrl,
      backupUrl: v.backupUrl,
      codecs: v.codecs,
      codecRank: codecRank(v.codecs),
      width: v.width,
      height: v.height,
      index: i,
    }));

    // 4) 默认选第一个 H.264 的（Chrome 必解），没有则退回第 0 个
    let defaultIdx = qualityOptions.findIndex(q => q.codecRank === 0);
    if (defaultIdx < 0) defaultIdx = 0;

    list.push({
      id: `bili_video_${Date.now()}`,
      url: videoSorted[defaultIdx].baseUrl,
      type: 'dash-video',
      title: title || playinfo.title || 'B站视频',
      format: 'm4s',
      duration: playinfo.duration || 0,
      poster: '',
      detectedAt: Date.now(),
      source: 'bilibili',
      qualityOptions: qualityOptions,
      selectedQuality: defaultIdx,
    });
  }

  // 音频流
  if (playinfo.audio && playinfo.audio.length > 0) {
    const audioSorted = [...playinfo.audio].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    list.push({
      id: `bili_audio_${Date.now()}`,
      url: audioSorted[0].baseUrl,
      type: 'dash-audio',
      title: title || playinfo.title || 'B站音频',
      format: 'm4s',
      duration: playinfo.duration || 0,
      poster: '',
      detectedAt: Date.now(),
      source: 'bilibili',
      qualityOptions: audioSorted.map((a, i) => ({
        label: BILIBILI_AUDIO_MAP[a.id] || `${Math.round((a.bandwidth || 0) / 1000)}kbps`,
        bandwidth: a.bandwidth,
        url: a.baseUrl,
        backupUrl: a.backupUrl,
        codecs: a.codecs,
        index: i,
      })),
      selectedQuality: 0,
    });
  }

  return list;
}

// ==================== M3U8 解析 ====================

function resolveUrl(url, baseUrl) {
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

function parseM3U8(content, baseUrl) {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const variants = [];
  const segments = [];
  let isMaster = false;
  let initSegmentUrl = null;
  let currentVariant = null;
  let keyInfo = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      isMaster = true;
      const attrs = parseAttributes(line.substring('#EXT-X-STREAM-INF:'.length));
      currentVariant = {
        bandwidth: parseInt(attrs.BANDWIDTH) || 0,
        resolution: attrs.RESOLUTION || '',
        codecs: attrs.CODECS || '',
        url: null,
      };
    } else if (currentVariant && !line.startsWith('#')) {
      currentVariant.url = resolveUrl(line, baseUrl);
      variants.push(currentVariant);
      currentVariant = null;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-MAP:'.length));
      if (attrs.URI) initSegmentUrl = resolveUrl(attrs.URI.replace(/"/g, ''), baseUrl);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-KEY:'.length));
      keyInfo = {
        method: attrs.METHOD || 'NONE',
        uri: attrs.URI ? resolveUrl(attrs.URI.replace(/"/g, ''), baseUrl) : null,
      };
    } else if (!line.startsWith('#') && !isMaster) {
      segments.push(resolveUrl(line, baseUrl));
    }
  }

  return { isMaster, variants, segments, initSegmentUrl, keyInfo };
}

async function fetchHLSVariants(m3u8Url) {
  try {
    const resp = await fetch(m3u8Url);
    const content = await resp.text();
    const parsed = parseM3U8(content, m3u8Url);
    if (parsed.isMaster) {
      return parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
    }
    // 单层播放列表，返回一个默认变体
    return [{ bandwidth: 0, resolution: '默认', url: m3u8Url, codecs: '' }];
  } catch (e) {
    console.error('[VC] 获取 HLS 变体失败:', e);
    return [];
  }
}

// 确保 HLS 清晰度选项已加载（GET_MEDIA_LIST 与 URL 扫描共用）
async function ensureHlsQualityOptions(mediaList) {
  for (const media of mediaList) {
    if (media.type === 'hls' && (!media.qualityOptions || media.qualityOptions.length <= 1)) {
      try {
        const variants = await fetchHLSVariants(media.url);
        if (variants && variants.length > 1) {
          media.qualityOptions = variants.map((v, i) => ({
            label: v.resolution || `${Math.round(v.bandwidth / 1000)}kbps`,
            bandwidth: v.bandwidth,
            url: v.url,
            index: i,
          }));
        }
      } catch (e) {}
    }
  }
}

// ==================== URL 扫描（搜索栏输入网址检测视频） ====================

// 从 HTML 源码提取视频直链：video/source 标签属性、og:video meta、
// 以及 JS/JSON 内嵌的裸 .mp4/.m3u8 等地址（覆盖懒加载与动态站点）。
function extractVideosFromHtml(html, baseUrl) {
  const found = new Map();

  const addUrl = (rawUrl) => {
    if (!rawUrl) return;
    const url = resolveUrl(rawUrl.trim().replace(/&amp;/g, '&'), baseUrl);
    if (!/^https?:/i.test(url)) return;
    const extM = url.match(MEDIA_EXT_RE);
    if (!extM) return;
    const ext = extM[1].toLowerCase();
    if (ext === 'ts') return; // TS 分段由 m3u8 任务统一处理
    let type = 'video';
    if (ext === 'm3u8') type = 'hls';
    else if (['m4a', 'aac', 'mp3', 'wav', 'flac', 'ogg'].includes(ext)) type = 'audio';
    else if (ext === 'm4s') type = 'dash';
    if (!found.has(url)) found.set(url, { url, ext, type });
  };

  // <video>/<audio>/<source> 标签属性、og:video meta
  const attrRes = [
    /<video[^>]+?\b(?:src|data-src|data-original)\s*=\s*["']([^"']+)["']/gi,
    /<source[^>]+?\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi,
    /<audio[^>]+?\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi,
    /<meta[^>]+property=["']og:video(?::secure_url|:url)?["'][^>]*?content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]*?property=["']og:video(?::secure_url|:url)?["']/gi,
  ];
  for (const re of attrRes) {
    let m;
    while ((m = re.exec(html)) !== null) addUrl(m[1]);
  }

  // 裸 URL：覆盖 <script> 内嵌变量、JSON 数据里的视频地址（含协议相对 // 写法）
  const rawUrlRe = /(?:https?:)?\/\/[^\s"'<>()\\]+?\.(?:m3u8|mp4|webm|flv|m4s)(?:\?[^\s"'<>()\\]*)?/gi;
  let m;
  while ((m = rawUrlRe.exec(html)) !== null) addUrl(m[0]);

  return [...found.values()];
}

// 等待标签页加载完成（status=complete），带超时兜底；标签页被关掉也立即返回
function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        setTimeout(finish, 300); // 部分站点 complete 后仍有二次跳转，稍候
      }
    };
    const removedListener = (removedTabId) => {
      if (removedTabId === tabId) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
  });
}

// 执行 URL 扫描：后台标签页加载目标网址（content script + webRequest 自动采集），
// 并行做静态 HTML 扫描兜底；B站额外提取 playinfo。
// 结果 state 搬到虚拟 key "scan_<tabId>"（标签页随后关闭，下载走 offscreen 按 URL 执行不依赖页面）。
async function scanUrlForVideos(rawUrl) {
  // 1. URL 规范化
  let url = (rawUrl || '').trim();
  if (!url) throw new Error('请输入网址');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error('无效的网址: ' + url);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('仅支持 http/https 网址');

  // 2. 清理上一次扫描的残留结果
  for (const key of [...tabStates.keys()]) {
    if (typeof key === 'string' && key.startsWith('scan_')) tabStates.delete(key);
  }

  // 3. 静态 HTML 扫描（与打开标签页并行；非 HTML / 超大页面 / 失败均静默放弃）
  const staticScanPromise = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const resp = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
      clearTimeout(timer);
      const contentType = resp.headers.get('content-type') || '';
      if (contentType && !contentType.includes('text/html')) return [];
      const html = await resp.text();
      if (html.length > 5 * 1024 * 1024) return [];
      return extractVideosFromHtml(html, url);
    } catch (e) {
      return [];
    }
  })();

  // 4. 后台打开页面（active:false 不抢焦点）
  const scanTab = await chrome.tabs.create({ url, active: false });
  const scanTabId = scanTab.id;

  try {
    await waitForTabComplete(scanTabId);
    // 等待 JS 渲染、媒体请求发出、content script 上报
    await new Promise(r => setTimeout(r, 4000));

    const state = getTabState(scanTabId);
    state.url = url;
    state.site = /bilibili\.com/.test(url) ? 'bilibili'
      : /douyin\.com/.test(url) ? 'douyin' : 'general';

    // 5. B站 playinfo 主动提取（页面服务端渲染，加载完成即在 window 上）
    if (state.site === 'bilibili' && !state.playinfo) {
      try {
        state.playinfo = await getBilibiliPlayinfo(scanTabId);
      } catch (e) {}
      if (state.playinfo) {
        const biliList = buildBilibiliMediaList(state.playinfo, state.title);
        // 去重规则与 GET_MEDIA_LIST 一致（三层去重见项目记忆）
        state.mediaList = state.mediaList.filter(m => {
          if (m.source === 'bilibili') return false;
          if (m.source === 'network' && BILIBILI_CDN_RE.test(m.url)) return false;
          return true;
        });
        state.mediaList.unshift(...biliList);
      }
    }

    // 6. 合并静态扫描结果（去重追加）
    const staticResults = await staticScanPromise;
    for (const item of staticResults) {
      if (state.mediaUrlSet.has(item.url)) continue;
      state.mediaUrlSet.add(item.url);
      state.mediaList.push({
        id: `scan_${scanTabId}_${Date.now()}_${state.mediaList.length}`,
        url: item.url,
        type: item.type,
        title: state.title || parsed.hostname,
        format: item.ext,
        duration: 0,
        poster: '',
        detectedAt: Date.now(),
        source: 'scan-html',
        qualityOptions: [],
        selectedQuality: 0,
      });
    }

    // 7. HLS 清晰度选项
    await ensureHlsQualityOptions(state.mediaList);

    // 8. state 搬到虚拟 key 并关闭探测标签页
    //    （Map 的 number key 与字符串 key 互不相同，onRemoved 的 delete 不影响虚拟 key）
    const virtualKey = `scan_${scanTabId}`;
    tabStates.set(virtualKey, state);
    try { await chrome.tabs.remove(scanTabId); } catch (e) {}

    return {
      mediaList: state.mediaList,
      title: state.title,
      site: state.site,
      scanUrl: url,
      tabId: virtualKey,
    };
  } catch (e) {
    try { await chrome.tabs.remove(scanTabId); } catch (_) {}
    throw e;
  }
}

// ==================== 下载工具函数 ====================

function sanitizeFilename(title) {
  return (title || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'video';
}

// 通过 Range 请求获取文件总大小（精确下载大小），失败返回 null
async function fetchContentLength(url) {
  if (!url || !url.startsWith('http')) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    // 206 Range：Content-Range: bytes 0-0/TOTAL
    const cr = resp.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) return parseInt(m[1], 10);
    }
    // 200 完整响应或服务器忽略 Range
    const cl = resp.headers.get('content-length');
    if (cl) return parseInt(cl, 10);
    return null;
  } catch (e) {
    return null;
  }
}

// ==================== 后台下载派发 ====================
// 下载任务交给 offscreen 常驻文档执行：
// popup 关闭（误触）或 Service Worker 被闲置回收都不影响任务，
// 只有用户在 popup 中确认取消才会中止。

function makeTaskId() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

let offscreenReadyPromise = null;

async function ensureOffscreenDocument() {
  // 文档可能已被闲置自动关闭，每次都先实际检查存在性
  if (chrome.runtime.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextNames: ['OFFSCREEN'],
      });
      if (contexts.length > 0) return;
    } catch (e) {}
  }

  // 并发去重：正在创建时复用同一个 promise
  if (offscreenReadyPromise) {
    await offscreenReadyPromise;
    return;
  }

  offscreenReadyPromise = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
        justification: 'Background download engine: fetch streams, merge video+audio, extract and encode audio',
      });
    } catch (e) {
      // 已存在则忽略
    }

    // 等待脚本加载
    await new Promise(resolve => setTimeout(resolve, 300));
  })();

  try {
    await offscreenReadyPromise;
  } finally {
    // 创建完成后清除缓存：之后每次调用都重新检查（文档可能已闲置关闭）
    offscreenReadyPromise = null;
  }
}

async function startBackgroundDownload(taskSpec) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_DOWNLOAD',
    task: taskSpec,
  });
  if (!response || response.error) {
    throw new Error(response?.error || '无法启动后台下载');
  }
  return response.taskId;
}

// ==================== 消息处理 ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 忽略发给 offscreen 的消息
  if (message.target === 'offscreen') return;

  if (message.type === 'OFFSCREEN_READY') {
    console.log('[VC] 离屏文档已就绪');
    return;
  }

  // offscreen 闲置自关失败时代为关闭
  if (message.type === 'OFFSCREEN_IDLE_CLOSE') {
    (async () => {
      try { await chrome.offscreen.closeDocument(); } catch (e) {}
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ----- 来自 content script -----
  if (message.type === 'VIDEO_DETECTED') {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    const state = getTabState(tabId);
    const src = message.video.src || '';
    const isBlob = src.startsWith('blob:');

    // 主 src（后台标签页中 autoplay 被阻止时 src 可能为空，此时跳过）
    if (src && !state.mediaUrlSet.has(src)) {
      state.mediaUrlSet.add(src);
      state.mediaList.push({
        id: `video_el_${tabId}_${Date.now()}_${state.mediaList.length}`,
        url: src,
        type: isBlob ? 'blob' : 'video',
        title: state.title || '未命名视频',
        format: isBlob ? 'blob' : (src.match(MEDIA_EXT_RE)?.[1]?.toLowerCase() || 'unknown'),
        duration: message.video.duration || 0,
        poster: message.video.poster || '',
        detectedAt: Date.now(),
        source: 'video-element',
        qualityOptions: [],
        selectedQuality: 0,
      });
    }

    // source 子元素（video.src 为空或为 blob 时，直链常在 <source> 里）
    (message.video.sources || []).forEach((s) => {
      if (!s.src || !/^https?:/i.test(s.src)) return;
      if (state.mediaUrlSet.has(s.src)) return;
      state.mediaUrlSet.add(s.src);
      state.mediaList.push({
        id: `video_src_${tabId}_${Date.now()}_${state.mediaList.length}`,
        url: s.src,
        type: 'video',
        title: state.title || '未命名视频',
        format: s.src.match(MEDIA_EXT_RE)?.[1]?.toLowerCase() || 'unknown',
        duration: message.video.duration || 0,
        poster: message.video.poster || '',
        detectedAt: Date.now(),
        source: 'video-element',
        qualityOptions: [],
        selectedQuality: 0,
      });
    });
    return;
  }

  if (message.type === 'TITLE_EXTRACTED') {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    const state = getTabState(tabId);
    state.title = message.title;
    // 更新已有媒体项的标题
    state.mediaList.forEach(item => {
      if (item.title === '未命名视频') item.title = message.title;
    });
    return;
  }

  // ----- 来自 popup -----

  if (message.type === 'GET_MEDIA_LIST') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
          sendResponse({ mediaList: [], title: '', site: 'general' });
          return;
        }

        const state = getTabState(tab.id);
        state.url = tab.url || '';

        // 判断站点
        if (tab.url && tab.url.includes('bilibili.com')) {
          state.site = 'bilibili';
        } else if (tab.url && tab.url.includes('douyin.com')) {
          state.site = 'douyin';
        } else {
          state.site = 'general';
        }

        // B站：主动提取 playinfo
        if (state.site === 'bilibili') {
          if (!state.playinfo) {
            state.playinfo = await getBilibiliPlayinfo(tab.id);
            if (state.playinfo) {
              const biliList = buildBilibiliMediaList(state.playinfo, state.title);
              // 合并到媒体列表：移除所有 B 站相关条目
              // 1) buildBilibiliMediaList 生成的旧条目（source='bilibili'）
              // 2) 网络拦截到的 B 站 CDN m4s 流（source='network' + BILIBILI_CDN_RE）
              //    每个清晰度 baseUrl+backupUrl 通常有 3 个 CDN 候选，不去重就会"每个分辨率3个视频"
              state.mediaList = state.mediaList.filter(m => {
                if (m.source === 'bilibili') return false;
                if (m.source === 'network' && BILIBILI_CDN_RE.test(m.url)) return false;
                return true;
              });
              state.mediaList.unshift(...biliList);
              state.downloadProgress = null;
            }
          }
        }

        // 确保 HLS 清晰度选项已加载
        await ensureHlsQualityOptions(state.mediaList);

        sendResponse({
          mediaList: state.mediaList,
          title: state.title,
          site: state.site,
          playinfo: state.playinfo ? {
            hasVideo: (state.playinfo.video || []).length > 0,
            hasAudio: (state.playinfo.audio || []).length > 0,
          } : null,
          downloadProgress: state.downloadProgress,
        });
      } catch (e) {
        console.error('[VC] GET_MEDIA_LIST 错误:', e);
        sendResponse({ mediaList: [], title: '', site: 'general', error: e.message });
      }
    })();
    return true; // 保持消息通道
  }

  // ----- URL 扫描（搜索栏输入网址，检测该页面包含的视频） -----
  if (message.type === 'SCAN_URL') {
    (async () => {
      try {
        const result = await scanUrlForVideos(message.url);
        if (!result.mediaList || result.mediaList.length === 0) {
          sendResponse({
            ...result,
            hint: '未在该页面检测到可下载视频。部分网站需播放视频后才会加载视频流，可尝试直接打开该页面播放后再检测。',
          });
          return;
        }
        sendResponse(result);
      } catch (e) {
        console.error('[VC] URL 扫描失败:', e);
        sendResponse({ error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'DOWNLOAD_MERGE') {
    (async () => {
      const { videoMediaId, audioMediaId, videoQualityIndex, audioQualityIndex, tabId: msgTabId } = message;
      try {
        // 消息 tabId 优先（URL 扫描结果存于虚拟 key），找不到再全局兜底
        const foundV = findMediaAndState(videoMediaId, msgTabId);
        const foundA = findMediaAndState(audioMediaId, msgTabId);
        const videoMedia = foundV?.media;
        const audioMedia = foundA?.media;

        if (!videoMedia || !audioMedia) {
          sendResponse({ error: '未找到视频或音频流' });
          return;
        }
        const state = foundV?.state || foundA?.state;
        const tabId = msgTabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;

        const title = sanitizeFilename(videoMedia.title);
        const vQ = videoMedia.qualityOptions[videoQualityIndex || 0] || videoMedia.qualityOptions[0];
        const aQ = audioMedia.qualityOptions[audioQualityIndex || 0] || audioMedia.qualityOptions[0];
        if (!vQ || !aQ) {
          sendResponse({ error: '清晰度选项无效' });
          return;
        }

        // 组装诊断上下文（出错时 offscreen 会基于此生成 Bug 报告）
        const ctx = {
          pageUrl: state?.url || '',
          videoUrl: vQ.url,
          audioUrl: aQ.url,
          qualityLabel: vQ.label || '',
        };

        // 任务交给 offscreen 常驻执行：下载两路流 + 合并 + 保存，
        // popup 关闭 / SW 被回收均不影响
        const taskId = makeTaskId();
        await startBackgroundDownload({
          id: taskId,
          mode: 'merge',
          kind: 'merge',
          mediaId: videoMedia.id, // 用视频流 id 定位合并卡片
          tabId,
          title: videoMedia.title,
          filename: title,
          video: { url: vQ.url, backupUrl: vQ.backupUrl || '', label: vQ.label || '' },
          audio: { url: aQ.url, backupUrl: aQ.backupUrl || '' },
          ctx,
        });
        sendResponse({ taskId });
      } catch (e) {
        console.error('[VC] 合并下载派发失败:', e);
        sendResponse({ error: e.message, diagnostics: e.diagnostics || null });
      }
    })();
    return true;
  }

  if (message.type === 'DOWNLOAD_VIDEO') {
    (async () => {
      const { mediaId, qualityIndex, tabId: msgTabId } = message;
      try {
        // 消息 tabId 优先（URL 扫描结果存于虚拟 key），找不到再全局兜底
        const found = findMediaAndState(mediaId, msgTabId);
        if (!found) {
          sendResponse({ error: '未找到媒体' });
          return;
        }
        const { media } = found;
        const tabId = msgTabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;

        const title = sanitizeFilename(media.title);
        const taskId = makeTaskId();

        if (media.type === 'hls') {
          await startBackgroundDownload({
            id: taskId, mode: 'video', kind: 'hls', mediaId, tabId,
            title: media.title, filename: `${title}.mp4`,
            url: media.url, qualityIndex: qualityIndex || 0,
          });
        } else if (media.type === 'dash-video') {
          // B站视频流
          const qOpts = media.qualityOptions[qualityIndex || 0] || media.qualityOptions[0];
          await startBackgroundDownload({
            id: taskId, mode: 'video', kind: 'm4s', mediaId, tabId,
            title: media.title, filename: `${title}.mp4`,
            url: qOpts?.url || media.url, backupUrl: qOpts?.backupUrl || '',
          });
        } else if (media.type === 'video' || media.type === 'dash') {
          // 直接 URL
          const ext = media.format || 'mp4';
          await startBackgroundDownload({
            id: taskId, mode: 'video', kind: 'direct', mediaId, tabId,
            title: media.title, filename: `${title}.${ext}`,
            url: media.url, mediaType: 'video',
          });
        } else if (media.type === 'blob') {
          throw new Error('Blob URL 视频无法直接下载，请尝试使用网络请求中的视频流');
        } else {
          throw new Error(`不支持的视频类型: ${media.type}`);
        }

        sendResponse({ taskId });
      } catch (e) {
        console.error('[VC] 下载视频派发失败:', e);
        sendResponse({ error: e.message, diagnostics: e.diagnostics || null });
      }
    })();
    return true;
  }

  if (message.type === 'DOWNLOAD_AUDIO') {
    (async () => {
      const { mediaId, format, bitrate, qualityIndex, tabId: msgTabId } = message;
      try {
        // 消息 tabId 优先（URL 扫描结果存于虚拟 key），找不到再全局兜底
        const found = findMediaAndState(mediaId, msgTabId);
        if (!found) {
          sendResponse({ error: '未找到媒体' });
          return;
        }
        const { media, state } = found;
        const stateUrl = state?.url || '';
        const tabId = msgTabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;

        // 设置选中的清晰度
        if (qualityIndex !== undefined && media.qualityOptions[qualityIndex]) {
          media.selectedQuality = qualityIndex;
        }

        const title = sanitizeFilename(media.title);
        const qOpt = media.qualityOptions?.[media.selectedQuality];
        const taskId = makeTaskId();

        // 扩展名规则：FLAC 源直存 .flac；wav/flac 目标格式存 .wav（无损替代）；其余 .mp3
        const audioExt = (media.type === 'dash-audio' && (qOpt?.codecs || '').includes('fLaC'))
          ? 'flac'
          : (format === 'mp3' ? 'mp3' : 'wav');

        let spec;
        if (media.type === 'dash-audio') {
          // B站音频流
          const url = qOpt?.url || media.url;
          spec = {
            sourceType: 'dash-audio',
            url,
            backupUrl: qOpt?.backupUrl || '',
            codecs: qOpt?.codecs || '',
            ctx: { pageUrl: stateUrl, videoUrl: url, qualityLabel: qOpt?.label || '' },
          };
        } else if (media.type === 'hls') {
          // 从 HLS 视频流提取音频
          spec = {
            sourceType: 'hls',
            url: media.url,
            qualityIndex: media.selectedQuality,
            ctx: { pageUrl: stateUrl, videoUrl: media.url },
          };
        } else {
          // 从直接 URL 视频流提取音频
          spec = {
            sourceType: 'direct',
            url: media.url,
            ctx: { pageUrl: stateUrl, videoUrl: media.url },
          };
        }

        await startBackgroundDownload({
          id: taskId,
          mode: 'audio',
          kind: 'audio',
          mediaId,
          tabId,
          title: media.title,
          filename: `${title}.${audioExt}`,
          format: format || 'mp3',
          bitrate: bitrate || 320,
          ...spec,
        });
        sendResponse({ taskId });
      } catch (e) {
        console.error('[VC] 音频下载派发失败:', e);
        sendResponse({ error: e.message, diagnostics: e.diagnostics || null });
      }
    })();
    return true;
  }

  // offscreen 无 chrome.downloads API：把 blob URL 交回 SW 执行下载
  // blob URL 在扩展 origin 内全局有效，SW 调 downloads.download 可读取 offscreen 创建的 blob
  if (message.type === 'SAVE_BLOB_DOWNLOAD') {
    (async () => {
      try {
        const downloadId = await chrome.downloads.download({
          url: message.url,
          filename: message.filename,
          saveAs: false,
        });
        sendResponse({ ok: true, downloadId });
      } catch (e) {
        sendResponse({ error: e.message || String(e) });
      }
    })();
    return true;
  }

  // ==================== 下载大小预估 ====================
  if (message.type === 'ESTIMATE_SIZE') {
    (async () => {
      try {
        const { mediaId, mode, qualityIndex, audioFormat, tabId: msgTabId } = message;
        // 消息 tabId 优先（URL 扫描结果存于虚拟 key），找不到再全局兜底
        const found = findMediaAndState(mediaId, msgTabId);
        if (!found) { sendResponse({ error: '未找到媒体' }); return; }
        const { media } = found;

        const qIndex = qualityIndex || 0;
        const est = estimateMediaSize(media, {
          mode,
          qualityIndex: qIndex,
          audioFormat: audioFormat || 'mp3-320',
        });

        // 仅"仅视频"下载可用服务器返回的精确文件大小
        // （音频会因格式转换而变化大小，合并会因 MediaRecorder 重编码而变化，故不取精确值）
        let finalBytes = est.bytes;
        let isExact = false;
        const singleUrlTypes = ['video', 'dash', 'dash-video', 'dash-audio'];
        if (singleUrlTypes.includes(media.type) && mode === 'video') {
          const q = (media.qualityOptions && media.qualityOptions[qIndex]) || media;
          const url = q.url || q.baseUrl || media.url;
          if (url && url.startsWith('http')) {
            const cl = await fetchContentLength(url);
            if (cl && cl > 0) { finalBytes = cl; isExact = true; }
          }
        }

        const qualityLabel = (media.qualityOptions && media.qualityOptions[qIndex]?.label) || '';
        sendResponse({
          mode,
          estimatedBytes: finalBytes,
          perMinuteBytes: est.perMinute,
          hasDuration: est.hasDuration,
          isExact,
          qualityLabel,
          audioFormat: audioFormat || 'mp3-320',
          note: isExact ? '精确（服务器文件大小）'
            : (est.hasDuration ? '预估（码率×时长）' : '预估（码率/分钟）'),
        });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (message.type === 'GET_PAGE_TITLE') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const state = getTabState(tab.id);
        // 尝试从 content script 获取标题
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_INFO' });
          if (response && response.title) {
            state.title = response.title;
          }
        } catch (e) {
          // content script 可能未注入
        }
        sendResponse({ title: state.title, url: state.url, site: state.site });
      } catch (e) {
        sendResponse({ title: '', url: '', site: 'general' });
      }
    })();
    return true;
  }

  if (message.type === 'REFRESH_MEDIA') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        clearTabState(tab.id);
        // 重新触发检测
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_INFO' });
        } catch (e) {}
      }
      sendResponse({ success: true });
    })();
    return true;
  }
});

// ==================== declarativeNetRequest 规则（设置 Referer） ====================

chrome.runtime.onInstalled.addListener(() => {
  const rules = [
    {
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com' },
        ],
      },
      condition: {
        urlFilter: '||bilivideo.com',
        resourceTypes: ['xmlhttprequest', 'other', 'media'],
      },
    },
    {
      id: 2,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com' },
        ],
      },
      condition: {
        urlFilter: '||bilivideo.cn',
        resourceTypes: ['xmlhttprequest', 'other', 'media'],
      },
    },
    {
      id: 3,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.douyin.com' },
        ],
      },
      condition: {
        urlFilter: '||douyinvod.com',
        resourceTypes: ['xmlhttprequest', 'other', 'media'],
      },
    },
  ];

  chrome.declarativeNetRequest.getDynamicRules((existing) => {
    const removeIds = existing.map(r => r.id).filter(id => id <= 10);
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: rules,
    });
  });
});

// ==================== 初始化 ====================

console.log('[VC] 视频抓取助手 background 已启动');
