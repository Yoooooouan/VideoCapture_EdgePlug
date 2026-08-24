/**
 * background.js — MV3 Service Worker
 * 核心逻辑：网络拦截、M3U8 解析、B站 playinfo 提取、下载管理、音频提取
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

// ==================== Tab 状态管理 ====================

const tabStates = new Map();

// 当前下载上下文（用于转发 offscreen 进度）
let currentDownload = { tabId: null, mediaId: null };

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
  if (playinfo.video && playinfo.video.length > 0) {
    const videoSorted = [...playinfo.video].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    const qualityOptions = videoSorted.map((v, i) => ({
      label: BILIBILI_QUALITY_MAP[v.id] || `${v.height}p` || `流${i + 1}`,
      bandwidth: v.bandwidth,
      url: v.baseUrl,
      backupUrl: v.backupUrl,
      codecs: v.codecs,
      width: v.width,
      height: v.height,
      index: i,
    }));

    list.push({
      id: `bili_video_${Date.now()}`,
      url: videoSorted[0].baseUrl,
      type: 'dash-video',
      title: title || playinfo.title || 'B站视频',
      format: 'm4s',
      duration: playinfo.duration || 0,
      poster: '',
      detectedAt: Date.now(),
      source: 'bilibili',
      qualityOptions: qualityOptions,
      selectedQuality: 0,
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

// ==================== 下载工具函数 ====================

function sanitizeFilename(title) {
  return (title || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'video';
}

function concatArrayBuffers(buffers) {
  const total = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const buf of buffers) {
    result.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return result.buffer;
}

// 注意：MV3 Service Worker 中没有 URL.createObjectURL，
// 因此所有 Blob → URL → chrome.downloads.download 的流程都要走 offscreen 文档。
async function downloadBlob(blob, filename) {
  await ensureOffscreenDocument();
  const arrayBuffer = await blob.arrayBuffer();
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'DOWNLOAD_BLOB',
    arrayBuffer,
    filename,
    mimeType: blob.type || 'application/octet-stream',
  });
  if (!response || response.error) {
    throw new Error(response?.error || '下载失败');
  }
}

// ==================== 进度跟踪 ====================

function updateProgress(tabId, mediaId, progress, message) {
  const state = getTabState(tabId);
  state.downloadProgress = {
    id: mediaId,
    progress: Math.round(progress),
    message: message,
    timestamp: Date.now(),
  };
  // 广播给 popup（如果开着）
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_PROGRESS',
    tabId,
    mediaId,
    progress: state.downloadProgress.progress,
    message: message,
  }).catch(() => {});
}

// ==================== HLS 下载 ====================

async function downloadHLS(m3u8Url, qualityIndex, filename, tabId, mediaId) {
  updateProgress(tabId, mediaId, 0, '正在解析播放列表...');

  const resp = await fetch(m3u8Url);
  const content = await resp.text();
  const parsed = parseM3U8(content, m3u8Url);

  // 检查加密
  if (parsed.keyInfo && parsed.keyInfo.method !== 'NONE') {
    throw new Error('加密的 HLS 流暂不支持');
  }

  let segmentUrls = [];
  let initSegment = null;

  if (parsed.isMaster) {
    // 主播放列表：选择清晰度
    const sorted = parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const selected = sorted[qualityIndex] || sorted[0];
    updateProgress(tabId, mediaId, 5, `已选择: ${selected.resolution || '默认'}`);

    // 获取媒体播放列表
    const resp2 = await fetch(selected.url);
    const content2 = await resp2.text();
    const parsed2 = parseM3U8(content2, selected.url);
    segmentUrls = parsed2.segments;
    initSegment = parsed2.initSegmentUrl;

    if (parsed2.keyInfo && parsed2.keyInfo.method !== 'NONE') {
      throw new Error('加密的 HLS 流暂不支持');
    }
  } else {
    segmentUrls = parsed.segments;
    initSegment = parsed.initSegmentUrl;
  }

  if (segmentUrls.length === 0) {
    throw new Error('未找到任何分段');
  }

  // 下载所有分段
  const buffers = [];
  const total = segmentUrls.length + (initSegment ? 1 : 0);

  // 下载 init segment（如果有）
  if (initSegment) {
    updateProgress(tabId, mediaId, 2, '下载初始化分段...');
    const r = await fetch(initSegment);
    buffers.push(await r.arrayBuffer());
  }

  // 下载媒体分段
  for (let i = 0; i < segmentUrls.length; i++) {
    const segResp = await fetch(segmentUrls[i]);
    buffers.push(await segResp.arrayBuffer());
    const pct = ((i + 1 + (initSegment ? 1 : 0)) / total) * 95;
    updateProgress(tabId, mediaId, pct, `下载分段 ${i + 1}/${segmentUrls.length}`);
  }

  // 合并
  updateProgress(tabId, mediaId, 97, '正在合并分段...');
  const merged = concatArrayBuffers(buffers);

  // 判断输出格式
  const isFMP4 = initSegment !== null;
  const mimeType = isFMP4 ? 'video/mp4' : 'video/mp2t';
  const ext = isFMP4 ? 'mp4' : 'ts';
  const finalName = filename.endsWith(`.${ext}`) ? filename : filename.replace(/\.[^.]+$/, '') + `.${ext}`;

  const blob = new Blob([merged], { type: mimeType });
  await downloadBlob(blob, finalName);

  updateProgress(tabId, mediaId, 100, '下载完成');
}

// ==================== 直接 URL 下载 ====================

async function downloadDirect(url, filename, tabId, mediaId, type) {
  updateProgress(tabId, mediaId, 0, '正在下载...');

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  const contentLength = parseInt(resp.headers.get('content-length') || '0');
  let received = 0;
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (contentLength > 0) {
      updateProgress(tabId, mediaId, (received / contentLength) * 95, `下载中 ${Math.round(received / 1024 / 1024)}MB`);
    }
  }

  updateProgress(tabId, mediaId, 97, '正在处理...');
  const merged = concatArrayBuffers(chunks.map(c => c.buffer));

  // 确定 MIME 类型和扩展名
  let mimeType = 'application/octet-stream';
  const ext = url.match(MEDIA_EXT_RE)?.[1]?.toLowerCase() || 'mp4';
  if (type === 'video') mimeType = ext === 'flv' ? 'video/x-flv' : 'video/mp4';
  else if (type === 'audio') mimeType = `audio/${ext}`;

  const blob = new Blob([merged], { type: mimeType });
  await downloadBlob(blob, filename);

  updateProgress(tabId, mediaId, 100, '下载完成');
}

// ==================== B站 m4s 下载 ====================

async function downloadBilibiliM4S(url, backupUrl, filename, tabId, mediaId) {
  updateProgress(tabId, mediaId, 0, '正在下载（B站）...');

  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    // 尝试备用 URL
    if (backupUrl) {
      updateProgress(tabId, mediaId, 0, '使用备用线路下载...');
      resp = await fetch(backupUrl);
    } else {
      throw e;
    }
  }

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  const contentLength = parseInt(resp.headers.get('content-length') || '0');
  let received = 0;
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (contentLength > 0) {
      updateProgress(tabId, mediaId, (received / contentLength) * 95,
        `下载中 ${Math.round(received / 1024 / 1024)}MB / ${Math.round(contentLength / 1024 / 1024)}MB`);
    } else {
      updateProgress(tabId, mediaId, -1, `下载中 ${Math.round(received / 1024 / 1024)}MB`);
    }
  }

  updateProgress(tabId, mediaId, 97, '正在处理...');
  const merged = concatArrayBuffers(chunks.map(c => c.buffer));
  const blob = new Blob([merged], { type: 'video/mp4' });
  await downloadBlob(blob, filename);

  updateProgress(tabId, mediaId, 100, '下载完成');
}

// ==================== 音频提取（通过 offscreen 文档） ====================

let offscreenReadyPromise = null;

async function ensureOffscreenDocument() {
  if (offscreenReadyPromise) return offscreenReadyPromise;

  offscreenReadyPromise = (async () => {
    // 检查是否已存在
    if (chrome.runtime.getContexts) {
      try {
        const contexts = await chrome.runtime.getContexts({
          contextNames: ['OFFSCREEN'],
        });
        if (contexts.length > 0) return;
      } catch (e) {}
    }

    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
        justification: 'Extract audio from video and encode to MP3/WAV',
      });
    } catch (e) {
      // 已存在则忽略
    }

    // 等待脚本加载
    await new Promise(resolve => setTimeout(resolve, 300));
  })();

  return offscreenReadyPromise;
}

async function extractAudioViaOffscreen(arrayBuffer, format, bitrate) {
  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'EXTRACT_AUDIO',
    arrayBuffer: arrayBuffer,
    format: format,     // 'mp3' | 'wav' | 'flac'
    bitrate: bitrate || 320,
  });

  if (!response || response.error) {
    throw new Error(response?.error || '音频提取失败');
  }

  return response.blob;
}

// ==================== 音频下载流程 ====================

async function downloadAudio(mediaItem, format, bitrate, tabId) {
  const title = sanitizeFilename(mediaItem.title);
  const mediaId = mediaItem.id;
  currentDownload = { tabId, mediaId };

  try {
    if (mediaItem.type === 'dash-audio') {
      // B站音频流：直接下载 m4s，然后转换格式
      updateProgress(tabId, mediaId, 0, '下载音频流...');

      const url = mediaItem.qualityOptions?.[mediaItem.selectedQuality]?.url || mediaItem.url;
      const backupUrl = mediaItem.qualityOptions?.[mediaItem.selectedQuality]?.backupUrl || '';

      let resp;
      try {
        resp = await fetch(url);
      } catch (e) {
        if (backupUrl) resp = await fetch(backupUrl);
        else throw e;
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const arrayBuffer = await resp.arrayBuffer();
      updateProgress(tabId, mediaId, 50, '正在编码音频...');

      // 如果原始格式是 FLAC，直接保存
      const codecs = mediaItem.qualityOptions?.[mediaItem.selectedQuality]?.codecs || '';
      if (codecs.includes('fLaC') || format === 'flac' && codecs.includes('fLaC')) {
        const blob = new Blob([arrayBuffer], { type: 'audio/flac' });
        await downloadBlob(blob, `${title}.flac`);
      } else if (format === 'flac') {
        // 非 FLAC 源，转为 WAV 作为无损替代
        const blob = await extractAudioViaOffscreen(arrayBuffer, 'wav', bitrate);
        await downloadBlob(blob, `${title}.wav`);
      } else {
        // 转为 MP3 或 WAV
        const blob = await extractAudioViaOffscreen(arrayBuffer, format, bitrate);
        const ext = format === 'wav' ? 'wav' : 'mp3';
        await downloadBlob(blob, `${title}.${ext}`);
      }

      updateProgress(tabId, mediaId, 100, '音频下载完成');

    } else {
      // 从视频流提取音频
      updateProgress(tabId, mediaId, 0, '下载视频流...');

      let arrayBuffer;
      if (mediaItem.type === 'hls') {
        // 先下载 HLS 分段并合并
        const resp = await fetch(mediaItem.url);
        const content = await resp.text();
        const parsed = parseM3U8(content, mediaItem.url);

        let segmentUrls = [];
        if (parsed.isMaster) {
          const sorted = parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
          const selected = sorted[mediaItem.selectedQuality] || sorted[0];
          const resp2 = await fetch(selected.url);
          const content2 = await resp2.text();
          segmentUrls = parseM3U8(content2, selected.url).segments;
        } else {
          segmentUrls = parsed.segments;
        }

        const buffers = [];
        for (let i = 0; i < segmentUrls.length; i++) {
          const r = await fetch(segmentUrls[i]);
          buffers.push(await r.arrayBuffer());
          updateProgress(tabId, mediaId, (i + 1) / segmentUrls.length * 40,
            `下载分段 ${i + 1}/${segmentUrls.length}`);
        }
        arrayBuffer = concatArrayBuffers(buffers);
      } else {
        // 直接 URL
        const resp = await fetch(mediaItem.url);
        arrayBuffer = await resp.arrayBuffer();
      }

      updateProgress(tabId, mediaId, 50, '正在提取并编码音频...');
      const blob = await extractAudioViaOffscreen(arrayBuffer, format, bitrate);
      const ext = format === 'wav' ? 'wav' : format === 'flac' ? 'wav' : 'mp3';
      await downloadBlob(blob, `${title}.${ext}`);

      updateProgress(tabId, mediaId, 100, '音频下载完成');
    }
  } catch (e) {
    console.error('[VC] 音频下载失败:', e);
    updateProgress(tabId, mediaId, -1, `错误: ${e.message}`);
    throw e;
  }
}

// ==================== 消息处理 ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 忽略发给 offscreen 的消息
  if (message.target === 'offscreen') return;

  // ----- 来自 offscreen 的进度报告 -----
  if (message.type === 'AUDIO_PROGRESS') {
    if (currentDownload.mediaId) {
      updateProgress(currentDownload.tabId, currentDownload.mediaId, message.progress, message.message);
    }
    return;
  }

  if (message.type === 'OFFSCREEN_READY') {
    console.log('[VC] 离屏文档已就绪');
    return;
  }

  // ----- 来自 content script -----
  if (message.type === 'VIDEO_DETECTED') {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    const state = getTabState(tabId);
    // 避免重复
    if (state.mediaUrlSet.has(message.video.src)) return;
    state.mediaUrlSet.add(message.video.src);

    const isBlob = message.video.src.startsWith('blob:');
    state.mediaList.push({
      id: `video_el_${tabId}_${Date.now()}_${state.mediaList.length}`,
      url: message.video.src,
      type: isBlob ? 'blob' : 'video',
      title: state.title || '未命名视频',
      format: isBlob ? 'blob' : (message.video.src.match(MEDIA_EXT_RE)?.[1]?.toLowerCase() || 'unknown'),
      duration: message.video.duration || 0,
      poster: message.video.poster || '',
      detectedAt: Date.now(),
      source: 'video-element',
      qualityOptions: [],
      selectedQuality: 0,
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
            updateProgress(tab.id, 'bili', 0, '正在获取视频信息...');
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
        for (const media of state.mediaList) {
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

  if (message.type === 'DOWNLOAD_MERGE') {
    (async () => {
      const { videoMediaId, audioMediaId, videoQualityIndex, audioQualityIndex, tabId: msgTabId } = message;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tab?.id || msgTabId;
        const state = getTabState(tabId);

        const videoMedia = state.mediaList.find(m => m.id === videoMediaId);
        const audioMedia = state.mediaList.find(m => m.id === audioMediaId);

        if (!videoMedia || !audioMedia) {
          sendResponse({ error: '未找到视频或音频流' });
          return;
        }

        const title = sanitizeFilename(videoMedia.title);
        const mergeId = videoMedia.id; // 用视频流 id 作为进度标识，popup 可定位到合并卡片
        currentDownload = { tabId, mediaId: mergeId };

        // 1. 下载视频流
        updateProgress(tabId, mergeId, 0, '下载视频流...');
        const vQ = videoMedia.qualityOptions[videoQualityIndex || 0] || videoMedia.qualityOptions[0];
        let videoBuffer;
        try {
          const vResp = await fetch(vQ.url);
          if (!vResp.ok) throw new Error(`HTTP ${vResp.status}`);
          videoBuffer = await vResp.arrayBuffer();
        } catch (e) {
          if (vQ.backupUrl) {
            const vResp = await fetch(vQ.backupUrl);
            if (!vResp.ok) throw new Error(`视频流 HTTP ${vResp.status}`);
            videoBuffer = await vResp.arrayBuffer();
          } else throw e;
        }

        // 2. 下载音频流
        updateProgress(tabId, mergeId, 25, '下载音频流...');
        const aQ = audioMedia.qualityOptions[audioQualityIndex || 0] || audioMedia.qualityOptions[0];
        let audioBuffer;
        try {
          const aResp = await fetch(aQ.url);
          if (!aResp.ok) throw new Error(`HTTP ${aResp.status}`);
          audioBuffer = await aResp.arrayBuffer();
        } catch (e) {
          if (aQ.backupUrl) {
            const aResp = await fetch(aQ.backupUrl);
            if (!aResp.ok) throw new Error(`音频流 HTTP ${aResp.status}`);
            audioBuffer = await aResp.arrayBuffer();
          } else throw e;
        }

        // 3. 直接传 ArrayBuffer 给 offscreen（Service Worker 没有 URL.createObjectURL）
        updateProgress(tabId, mergeId, 40, '准备合并...');

        // 4. 发送到 offscreen 合并（offscreen 内部创建 blob URL、合并、并直接下载）
        await ensureOffscreenDocument();

        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'MERGE_VIDEO_AUDIO',
          videoBuffer,
          audioBuffer,
          filename: `${title}`,
          mergeId,
          tabId,
        });

        // 释放原始 buffer 内存
        videoBuffer = null;
        audioBuffer = null;

        if (!response || response.error) {
          throw new Error(response?.error || '合并失败');
        }

        // offscreen 已完成下载
        updateProgress(tabId, mergeId, 100, '视频+音频合并下载完成');
        sendResponse({ success: true });
      } catch (e) {
        console.error('[VC] 合并下载失败:', e);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (message.type === 'DOWNLOAD_VIDEO') {
    (async () => {
      const { mediaId, qualityIndex, tabId: msgTabId } = message;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tab?.id || msgTabId;
        const state = getTabState(tabId);
        const media = state.mediaList.find(m => m.id === mediaId);
        if (!media) {
          sendResponse({ error: '未找到媒体' });
          return;
        }

        const title = sanitizeFilename(media.title);
        currentDownload = { tabId, mediaId };

        if (media.type === 'hls') {
          // HLS 下载
          await downloadHLS(media.url, qualityIndex || 0, `${title}.mp4`, tabId, mediaId);
        } else if (media.type === 'dash-video') {
          // B站视频流
          const qOpts = media.qualityOptions[qualityIndex || 0] || media.qualityOptions[0];
          const url = qOpts?.url || media.url;
          const backupUrl = qOpts?.backupUrl || '';
          await downloadBilibiliM4S(url, backupUrl, `${title}.mp4`, tabId, mediaId);
        } else if (media.type === 'video' || media.type === 'dash') {
          // 直接 URL
          const ext = media.format || 'mp4';
          await downloadDirect(media.url, `${title}.${ext}`, tabId, mediaId, 'video');
        } else if (media.type === 'blob') {
          throw new Error('Blob URL 视频无法直接下载，请尝试使用网络请求中的视频流');
        } else {
          throw new Error(`不支持的视频类型: ${media.type}`);
        }

        sendResponse({ success: true });
      } catch (e) {
        console.error('[VC] 下载视频失败:', e);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (message.type === 'DOWNLOAD_AUDIO') {
    (async () => {
      const { mediaId, format, bitrate, qualityIndex, tabId: msgTabId } = message;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tab?.id || msgTabId;
        const state = getTabState(tabId);
        const media = state.mediaList.find(m => m.id === mediaId);
        if (!media) {
          sendResponse({ error: '未找到媒体' });
          return;
        }

        // 设置选中的清晰度
        if (qualityIndex !== undefined && media.qualityOptions[qualityIndex]) {
          media.selectedQuality = qualityIndex;
        }

        await downloadAudio(media, format || 'mp3', bitrate || 320, tabId);
        sendResponse({ success: true });
      } catch (e) {
        console.error('[VC] 下载音频失败:', e);
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
