/**
 * content/content.js
 * 内容脚本：检测页面视频元素、提取标题、监听 DOM 变化
 * 在所有页面注入，向 background 报告视频信息
 */

(function () {
  'use strict';

  let reportedVideos = new Map(); // key: video src, value: video info
  let lastReportedTitle = '';
  let observer = null;

  // ==================== 标题提取 ====================

  function extractTitle() {
    // B站
    if (location.hostname.includes('bilibili.com')) {
      const el =
        document.querySelector('.video-title .tit') ||
        document.querySelector('.video-title') ||
        document.querySelector('h1.video-title') ||
        document.querySelector('[class*="video-title"]');
      if (el && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }

    // 抖音
    if (location.hostname.includes('douyin.com')) {
      const el =
        document.querySelector('[data-e2e="video-desc"]') ||
        document.querySelector('.video-info-detail') ||
        document.querySelector('[class*="title"] [class*="desc"]');
      if (el && el.textContent.trim()) {
        return el.textContent.trim().slice(0, 100);
      }
    }

    // 通用：og:title
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && ogTitle.content) return ogTitle.content.trim();

    // 通用：meta title
    const metaTitle = document.querySelector('meta[name="title"]');
    if (metaTitle && metaTitle.content) return metaTitle.content.trim();

    // 通用：document.title（清理后缀）
    if (document.title) {
      return document.title
        .replace(/[-_|]\s*(bilibili|哔哩哔哩|抖音|douyin).*$/i, '')
        .replace(/[-_|]\s*.*播放页.*$/i, '')
        .trim();
    }

    return '未命名视频';
  }

  // ==================== 视频元素检测 ====================

  function getVideoInfo(videoEl) {
    const src = videoEl.src || videoEl.currentSrc || '';
    const poster = videoEl.poster || '';

    // 获取所有 source 子元素
    const sources = [];
    if (videoEl.querySelectorAll) {
      videoEl.querySelectorAll('source').forEach((s) => {
        if (s.src) sources.push({ src: s.src, type: s.type || '' });
      });
    }

    return {
      src: src,
      currentSrc: videoEl.currentSrc || src,
      poster: poster,
      sources: sources,
      duration: videoEl.duration || 0,
      videoWidth: videoEl.videoWidth || 0,
      videoHeight: videoEl.videoHeight || 0,
      readyState: videoEl.readyState,
    };
  }

  function detectVideos() {
    const videos = document.querySelectorAll('video');
    let found = false;

    videos.forEach((video, idx) => {
      const info = getVideoInfo(video);
      const key = info.src || info.currentSrc || `video_${idx}`;

      if (!reportedVideos.has(key) && (info.src || info.sources.length > 0)) {
        found = true;
        reportedVideos.set(key, info);

        // 发送到 background
        try {
          chrome.runtime.sendMessage({
            type: 'VIDEO_DETECTED',
            video: info,
            pageUrl: location.href,
            pageHostname: location.hostname,
          });
        } catch (e) {
          // 扩展可能正在重载，忽略
        }
      }
    });

    return found;
  }

  // ==================== 定期检测 ====================

  let detectTimer = null;

  function startDetection() {
    // 立即检测一次
    detectVideos();
    reportTitle();

    // 定期检测（每 2 秒）
    detectTimer = setInterval(() => {
      detectVideos();
      reportTitle();
    }, 2000);

    // DOM 变化监听
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      detectVideos();
      reportTitle();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function reportTitle() {
    const title = extractTitle();
    if (title && title !== lastReportedTitle) {
      lastReportedTitle = title;
      try {
        chrome.runtime.sendMessage({
          type: 'TITLE_EXTRACTED',
          title: title,
          pageUrl: location.href,
          pageHostname: location.hostname,
        });
      } catch (e) {
        // 忽略
      }
    }
  }

  // ==================== 消息处理 ====================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 忽略发给 offscreen 的消息
    if (message.target === 'offscreen') return;

    if (message.type === 'PING') {
      sendResponse({ alive: true, url: location.href, hostname: location.hostname });
      return true;
    }

    if (message.type === 'GET_PAGE_INFO') {
      detectVideos();
      sendResponse({
        title: extractTitle(),
        url: location.href,
        hostname: location.hostname,
        videoCount: document.querySelectorAll('video').length,
      });
      return true;
    }

    if (message.type === 'CAPTURE_STREAM_REQUEST') {
      // 从视频元素获取 captureStream（用于 blob URL 的备选方案）
      const videos = document.querySelectorAll('video');
      if (videos.length > 0) {
        const video = videos[0];
        try {
          if (video.captureStream) {
            const stream = video.captureStream();
            sendResponse({ success: true, hasStream: true });
            // 实际录制逻辑由 popup 通过 offscreen 处理
          } else {
            sendResponse({ success: false, error: 'captureStream not supported' });
          }
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      } else {
        sendResponse({ success: false, error: 'No video element found' });
      }
      return true;
    }
  });

  // ==================== 启动 ====================

  // 页面加载完成后开始检测
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(startDetection, 500);
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(startDetection, 500);
    });
  }

  // 页面卸载时清理
  window.addEventListener('beforeunload', () => {
    if (detectTimer) clearInterval(detectTimer);
    if (observer) observer.disconnect();
  });
})();
