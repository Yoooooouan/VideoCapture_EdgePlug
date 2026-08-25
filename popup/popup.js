/**
 * popup/popup.js
 * 弹窗逻辑：加载媒体列表、渲染卡片、派发下载、后台任务区展示与取消
 * 下载任务常驻 offscreen 引擎执行：关闭弹窗不中断，重开自动恢复进度。
 */

(function () {
  'use strict';

  // ==================== 状态 ====================
  let currentMediaList = [];
  let currentSite = 'general';
  // B站合并卡片：audioMediaId → videoMediaId（卡片进度条/按钮挂在 videoMedia.id 上）
  const combinedAnchor = new Map();

  // ==================== 下载大小预估 ====================
  function formatBytes(n) {
    if (n === null || n === undefined || isNaN(n) || n <= 0) return '未知';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function formatEstimate(resp) {
    if (!resp || resp.error) return '—';
    const parts = [];
    if (resp.estimatedBytes && resp.estimatedBytes > 0) {
      const tag = resp.isExact
        ? '<b style="color:#2e7d32;">精确</b>'
        : '预估';
      parts.push(`${tag} ${formatBytes(resp.estimatedBytes)}`);
    } else if (resp.perMinuteBytes && resp.perMinuteBytes > 0) {
      parts.push(`≈ ${formatBytes(resp.perMinuteBytes)}/分钟`);
    } else {
      parts.push('未知');
    }
    if (resp.qualityLabel) {
      parts.push(`<span style="color:#999;font-size:10px;">(${escapeHtml(resp.qualityLabel)})</span>`);
    }
    return parts.join(' ');
  }

  // mode: 'video' | 'audio' | 'merge'
  async function updateEstimate(media, mode) {
    const suffix = mode === 'merge' ? 'merge' : (mode === 'audio' ? 'audio' : 'video');
    const el = document.getElementById(`est-${suffix}-${media.id}`);
    if (!el) return;

    let qualityIndex = 0;
    const qSel = document.getElementById(`quality-${media.id}`);
    if (qSel) qualityIndex = parseInt(qSel.value, 10) || 0;

    let audioFormat = 'mp3-320';
    const fSel = document.getElementById(`audiofmt-${media.id}`);
    if (fSel) audioFormat = fSel.value;

    el.innerHTML = '计算中…';
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'ESTIMATE_SIZE',
        mediaId: media.id,
        mode,
        qualityIndex,
        audioFormat,
      });
      el.innerHTML = formatEstimate(resp);
    } catch (e) {
      el.innerHTML = '—';
    }
  }

  function triggerCardEstimates(media) {
    if (canDownloadVideo(media)) updateEstimate(media, 'video');
    if (canDownloadAudio(media)) updateEstimate(media, 'audio');
  }

  function resolveCardId(mediaId) {
    return combinedAnchor.get(mediaId) || mediaId;
  }

  // ==================== 初始化 ====================
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    // 监听来自 offscreen 下载引擎的进度广播
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'DOWNLOAD_PROGRESS') {
        handleProgressUpdate(message);
      }
    });

    // 先渲染媒体卡片，再恢复后台任务（任务联动卡片依赖卡片已存在）
    await loadMediaList();
    await refreshTasks();
  }

  // ==================== 加载媒体列表 ====================
  async function loadMediaList() {
    showLoading();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_MEDIA_LIST' });
      if (response && response.error) {
        showError(response.error);
        return;
      }
      currentMediaList = response?.mediaList || [];
      currentSite = response?.site || 'general';
      renderUI(response);
    } catch (e) {
      showError('无法连接到后台服务: ' + e.message);
    }
  }

  // ==================== 渲染 UI ====================
  function renderUI(data) {
    // 站点标识
    const badge = document.getElementById('site-badge');
    if (data.site === 'bilibili') badge.textContent = 'B站';
    else if (data.site === 'douyin') badge.textContent = '抖音';
    else if (data.site === 'general') badge.textContent = '';
    else badge.textContent = data.site;

    if (!data.mediaList || data.mediaList.length === 0) {
      renderEmpty();
    } else {
      renderMediaList(data.mediaList, data.downloadProgress, data.site);
    }
  }

  function showLoading() {
    document.getElementById('content').innerHTML = `
      <div class="empty-state">
        <div class="icon">⏳</div>
        <div class="title">正在检测视频...</div>
        <div class="desc">请稍候，正在分析当前页面</div>
      </div>`;
  }

  function renderEmpty() {
    document.getElementById('content').innerHTML = `
      <div class="empty-state">
        <div class="icon">🔍</div>
        <div class="title">未检测到视频</div>
        <div class="desc">
          请先在页面上播放视频，<br>
          然后点击下方刷新按钮
        </div>
        <button class="btn btn-primary" style="margin-top:16px;max-width:160px;" id="refresh-empty">🔄 刷新</button>
      </div>`;
    document.getElementById('refresh-empty').addEventListener('click', loadMediaList);
  }

  function showError(msg) {
    document.getElementById('content').innerHTML = `
      <div class="empty-state">
        <div class="icon">⚠️</div>
        <div class="title">出错了</div>
        <div class="desc">${escapeHtml(msg)}</div>
        <button class="btn btn-primary" style="margin-top:16px;max-width:160px;" id="refresh-err">🔄 重试</button>
      </div>`;
    const btn = document.getElementById('refresh-err');
    if (btn) btn.addEventListener('click', loadMediaList);
  }

  function renderMediaList(mediaList, downloadProgress, site) {
    const content = document.getElementById('content');
    content.innerHTML = '';
    combinedAnchor.clear();

    // 刷新按钮
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:8px;';
    toolbar.innerHTML = `<button class="btn btn-secondary" style="flex:none;padding:6px 12px;font-size:12px;" id="refresh-btn">🔄 刷新</button>`;
    content.appendChild(toolbar);
    document.getElementById('refresh-btn').addEventListener('click', loadMediaList);

    // B站提示
    if (site === 'bilibili') {
      const videoMedia = mediaList.find(m => m.type === 'dash-video');
      const audioMedia = mediaList.find(m => m.type === 'dash-audio');
      if (videoMedia && audioMedia) {
        const note = document.createElement('div');
        note.style.cssText = 'padding:8px 12px;background:#e8f5e9;border-radius:8px;font-size:11px;color:#2e7d32;margin-bottom:8px;line-height:1.5;';
        note.innerHTML = '✅ B站已识别视频+音频双流。推荐使用<b>「下载视频+音频」</b>直接获取带声音的完整视频，无需手动合并。';
        content.appendChild(note);

        // 合并卡片（主入口）
        const card = renderBilibiliCombinedCard(videoMedia, audioMedia, downloadProgress);
        content.appendChild(card);
        updateEstimate(videoMedia, 'merge');
        updateEstimate(audioMedia, 'audio');

        // 渲染其余媒体项（网络拦截到的其他流）
        mediaList.filter(m => m !== videoMedia && m !== audioMedia).forEach((media) => {
          const c = renderVideoCard(media, downloadProgress);
          content.appendChild(c);
          triggerCardEstimates(media);
        });
        return;
      }

      // 只有单流时的提示
      const note = document.createElement('div');
      note.style.cssText = 'padding:8px 12px;background:#fff3cd;border-radius:8px;font-size:11px;color:#856404;margin-bottom:8px;line-height:1.5;';
      note.innerHTML = 'ℹ️ B站视频和音频为独立流。<b>视频文件不含音频</b>，如需完整视频请同时下载视频和音频并用工具合并。';
      content.appendChild(note);
    }

    // 渲染每个媒体卡片
    mediaList.forEach((media) => {
      const card = renderVideoCard(media, downloadProgress);
      content.appendChild(card);
      triggerCardEstimates(media);
    });
  }

  // ==================== 视频卡片 ====================
  function renderVideoCard(media, downloadProgress) {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.id = `card-${media.id}`;

    // --- 卡片头部 ---
    const header = document.createElement('div');
    header.className = 'card-header';
    header.innerHTML = `
      <div class="card-title">${escapeHtml(media.title)}</div>
      <div class="card-meta">
        <span class="badge ${badgeClass(media)}">${badgeText(media)}</span>
        ${media.duration > 0 ? `<span>⏱ ${formatDuration(media.duration)}</span>` : ''}
        <span>${(media.format || 'unknown').toUpperCase()}</span>
      </div>`;
    card.appendChild(header);

    // --- 预览区域 ---
    const preview = document.createElement('div');
    preview.className = 'preview-area';
    if (media.poster) {
      preview.innerHTML = `<img src="${escapeHtml(media.poster)}" style="width:100%;max-height:180px;object-fit:cover;display:block;">`;
    } else if (canPreview(media)) {
      const v = document.createElement('video');
      v.controls = true;
      v.preload = 'metadata';
      v.style.cssText = 'width:100%;max-height:180px;display:block;';
      v.src = media.url;
      preview.appendChild(v);
    } else {
      const ph = document.createElement('div');
      ph.className = 'preview-placeholder';
      ph.textContent = getPreviewNote(media);
      preview.appendChild(ph);
    }
    card.appendChild(preview);

    // --- 选项区域 ---
    const options = document.createElement('div');
    options.className = 'options';

    // 清晰度选择
    if (media.qualityOptions && media.qualityOptions.length > 0) {
      const row = document.createElement('div');
      row.className = 'option-row';
      row.innerHTML = `
        <span class="option-label">清晰度:</span>
        <select id="quality-${media.id}">
          ${media.qualityOptions.map((q, i) =>
            `<option value="${i}" ${i === (media.selectedQuality || 0) ? 'selected' : ''}>${escapeHtml(q.label)}</option>`
          ).join('')}
        </select>`;
      options.appendChild(row);
      const qSel = row.querySelector('select');
      qSel.addEventListener('change', () => {
        if (canDownloadVideo(media)) updateEstimate(media, 'video');
        if (canDownloadAudio(media)) updateEstimate(media, 'audio');
      });
    }

    // 音频格式选择
    if (canDownloadAudio(media)) {
      const row = document.createElement('div');
      row.className = 'option-row';
      row.innerHTML = `
        <span class="option-label">音频格式:</span>
        <select id="audiofmt-${media.id}">
          <option value="mp3-320">MP3 320kbps</option>
          <option value="mp3-192">MP3 192kbps</option>
          <option value="mp3-128">MP3 128kbps</option>
          <option value="wav">WAV 无损</option>
          <option value="flac">FLAC 无损</option>
        </select>`;
      options.appendChild(row);
      const fSel = row.querySelector('select');
      fSel.addEventListener('change', () => updateEstimate(media, 'audio'));
    }

    card.appendChild(options);

    // --- 预估大小区域 ---
    const estBlock = document.createElement('div');
    estBlock.className = 'estimate-block';
    let estHtml = '';
    if (canDownloadVideo(media)) {
      estHtml += `<div class="estimate-row"><span class="estimate-label">📦 视频预估：</span><span id="est-video-${media.id}">计算中…</span></div>`;
    }
    if (canDownloadAudio(media)) {
      estHtml += `<div class="estimate-row"><span class="estimate-label">🎵 音频预估：</span><span id="est-audio-${media.id}">计算中…</span></div>`;
    }
    if (estHtml) {
      estBlock.innerHTML = estHtml;
      card.appendChild(estBlock);
    }

    // --- 按钮区域 ---
    const btnGroup = document.createElement('div');
    btnGroup.className = 'btn-group';

    if (canDownloadVideo(media)) {
      const vBtn = document.createElement('button');
      vBtn.className = 'btn btn-primary';
      vBtn.id = `dlvideo-${media.id}`;
      vBtn.innerHTML = '⬇ 下载视频';
      vBtn.addEventListener('click', () => handleDownloadVideo(media));
      btnGroup.appendChild(vBtn);
    }

    if (canDownloadAudio(media)) {
      const aBtn = document.createElement('button');
      aBtn.className = 'btn btn-secondary';
      aBtn.id = `dlaudio-${media.id}`;
      aBtn.innerHTML = '🎵 下载音频';
      aBtn.addEventListener('click', () => handleDownloadAudio(media));
      btnGroup.appendChild(aBtn);
    }

    if (btnGroup.children.length === 0) {
      const note = document.createElement('div');
      note.style.cssText = 'padding:8px;font-size:12px;color:#999;text-align:center;';
      note.textContent = '此媒体项不支持下载';
      btnGroup.appendChild(note);
    }

    card.appendChild(btnGroup);

    // --- 进度区域 ---
    const prog = document.createElement('div');
    prog.className = 'progress-section';
    prog.id = `prog-${media.id}`;
    prog.style.display = 'none';
    prog.innerHTML = `
      <div class="status-text" id="status-${media.id}"></div>
      <div class="progress-bar"><div class="progress-fill" id="fill-${media.id}"></div></div>`;
    card.appendChild(prog);

    // 如果有正在进行的下载，显示进度
    if (downloadProgress && downloadProgress.id === media.id) {
      showProgress(media.id, downloadProgress.progress, downloadProgress.message);
    }

    return card;
  }

  // ==================== B站合并卡片（视频+音频） ====================

  function renderBilibiliCombinedCard(videoMedia, audioMedia, downloadProgress) {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.id = `card-${videoMedia.id}`;
    card.style.border = '1px solid #a5d6a7';

    // 登记 audioMediaId → videoMediaId 映射（进度与按钮联动）
    combinedAnchor.set(audioMedia.id, videoMedia.id);

    // --- 卡片头部 ---
    const header = document.createElement('div');
    header.className = 'card-header';
    header.innerHTML = `
      <div class="card-title">${escapeHtml(videoMedia.title)}</div>
      <div class="card-meta">
        <span class="badge badge-bilibili">B站</span>
        ${videoMedia.duration > 0 ? `<span>⏱ ${formatDuration(videoMedia.duration)}</span>` : ''}
        <span>视频+音频双流</span>
      </div>`;
    card.appendChild(header);

    // --- 预览区域 ---
    const preview = document.createElement('div');
    preview.className = 'preview-area';
    if (videoMedia.poster) {
      preview.innerHTML = `<img src="${escapeHtml(videoMedia.poster)}" style="width:100%;max-height:180px;object-fit:cover;display:block;">`;
    } else if (videoMedia.url.startsWith('http')) {
      const v = document.createElement('video');
      v.controls = true;
      v.preload = 'metadata';
      v.muted = true; // 视频流无声，静音避免误会
      v.style.cssText = 'width:100%;max-height:180px;display:block;';
      v.src = videoMedia.url;
      preview.appendChild(v);
    } else {
      const ph = document.createElement('div');
      ph.className = 'preview-placeholder';
      ph.textContent = ' 预览不可用（纯视频流无声音）';
      preview.appendChild(ph);
    }
    card.appendChild(preview);

    // --- 选项区域 ---
    const options = document.createElement('div');
    options.className = 'options';

    // 清晰度选择（视频）
    if (videoMedia.qualityOptions && videoMedia.qualityOptions.length > 0) {
      const row = document.createElement('div');
      row.className = 'option-row';
      row.innerHTML = `
        <span class="option-label">清晰度:</span>
        <select id="quality-${videoMedia.id}">
          ${videoMedia.qualityOptions.map((q, i) =>
            `<option value="${i}" ${i === (videoMedia.selectedQuality || 0) ? 'selected' : ''}>${escapeHtml(q.label)}</option>`
          ).join('')}
        </select>`;
      options.appendChild(row);
      const qSel = row.querySelector('select');
      qSel.addEventListener('change', () => {
        updateEstimate(videoMedia, 'merge');
        updateEstimate(audioMedia, 'audio');
      });
    }

    // 音频格式选择（仅"下载音频"时生效，id 用 audioMedia.id 与 handleDownloadAudio 对齐）
    const row2 = document.createElement('div');
    row2.className = 'option-row';
    row2.innerHTML = `
      <span class="option-label">音频格式:</span>
      <select id="audiofmt-${audioMedia.id}">
        <option value="mp3-320">MP3 320kbps</option>
        <option value="mp3-192">MP3 192kbps</option>
        <option value="mp3-128">MP3 128kbps</option>
        <option value="wav">WAV 无损</option>
        <option value="flac">FLAC 无损</option>
      </select>`;
    options.appendChild(row2);
    const fSel = row2.querySelector('select');
    fSel.addEventListener('change', () => updateEstimate(audioMedia, 'audio'));

    card.appendChild(options);

    // --- 预估大小区域 ---
    const estBlock = document.createElement('div');
    estBlock.className = 'estimate-block';
    estBlock.innerHTML = `
      <div class="estimate-row"><span class="estimate-label">📦 合并预估：</span><span id="est-merge-${videoMedia.id}">计算中…</span></div>
      <div class="estimate-row"><span class="estimate-label">🎵 仅音频预估：</span><span id="est-audio-${audioMedia.id}">计算中…</span></div>`;
    card.appendChild(estBlock);

    // --- 按钮区域：①合并 ②仅视频 ③仅音频 ---
    const btnGroup = document.createElement('div');
    btnGroup.className = 'btn-group';

    // ① 下载视频+音频（合并，主推）
    const mergeBtn = document.createElement('button');
    mergeBtn.className = 'btn btn-merge';
    mergeBtn.id = `dlmerge-${videoMedia.id}`;
    mergeBtn.innerHTML = '🎬 下载视频+音频（推荐）';
    mergeBtn.addEventListener('click', () => handleDownloadMerge(videoMedia, audioMedia));
    btnGroup.appendChild(mergeBtn);

    // ② 仅视频
    const vBtn = document.createElement('button');
    vBtn.className = 'btn btn-secondary';
    vBtn.id = `dlvideo-${videoMedia.id}`;
    vBtn.innerHTML = '⬇ 仅视频（无声）';
    vBtn.addEventListener('click', () => handleDownloadVideo(videoMedia));
    btnGroup.appendChild(vBtn);

    // ③ 仅音频
    const aBtn = document.createElement('button');
    aBtn.className = 'btn btn-secondary';
    aBtn.id = `dlaudio-${videoMedia.id}`;
    aBtn.innerHTML = '🎵 仅音频';
    aBtn.addEventListener('click', () => handleDownloadAudio(audioMedia));
    btnGroup.appendChild(aBtn);

    card.appendChild(btnGroup);

    // --- 进度区域 ---
    const prog = document.createElement('div');
    prog.className = 'progress-section';
    prog.id = `prog-${videoMedia.id}`;
    prog.style.display = 'none';
    prog.innerHTML = `
      <div class="status-text" id="status-${videoMedia.id}"></div>
      <div class="progress-bar"><div class="progress-fill" id="fill-${videoMedia.id}"></div></div>`;
    card.appendChild(prog);

    // 显示进行中的进度
    if (downloadProgress && downloadProgress.id === videoMedia.id) {
      showProgress(videoMedia.id, downloadProgress.progress, downloadProgress.message);
    }

    return card;
  }

  async function handleDownloadMerge(videoMedia, audioMedia) {
    const qSelect = document.getElementById(`quality-${videoMedia.id}`);
    const vIndex = qSelect ? parseInt(qSelect.value) : (videoMedia.selectedQuality || 0);

    setButtonsDisabled(videoMedia.id, true);
    showProgress(videoMedia.id, 0, '准备合并下载...');

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'DOWNLOAD_MERGE',
        videoMediaId: videoMedia.id,
        audioMediaId: audioMedia.id,
        videoQualityIndex: vIndex,
        audioQualityIndex: 0, // 音频默认最高码率
      });
      if (resp && resp.error) {
        showProgress(videoMedia.id, -1, '❌ ' + resp.error);
        if (resp.diagnostics) showDiagnostics(videoMedia.id, resp.diagnostics);
        setButtonsDisabled(videoMedia.id, false);
      } else if (resp && resp.taskId) {
        // 任务已交给 offscreen 常驻执行，关闭弹窗不会中断
        showProgress(videoMedia.id, 1, '已加入后台下载，关闭弹窗不会中断');
      }
    } catch (e) {
      showProgress(videoMedia.id, -1, '❌ ' + e.message);
      setButtonsDisabled(videoMedia.id, false);
    }
  }

  // ==================== 后台下载任务区 ====================
  // 任务常驻 offscreen 引擎执行：误触关闭弹窗不中断下载，
  // 重新打开 popup 自动恢复任务列表与进度；取消必须用户明确确认。

  let taskList = [];

  async function refreshTasks() {
    try {
      const resp = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'GET_DOWNLOAD_STATUS',
      });
      taskList = (resp && resp.tasks) || [];
    } catch (e) {
      // offscreen 未创建 = 没有任何后台任务
      taskList = [];
    }
    renderTasks();
  }

  function modeIcon(t) {
    if (t.mode === 'merge') return '🎬';
    if (t.mode === 'audio') return '🎵';
    return '⬇';
  }

  function renderTasks() {
    const box = document.getElementById('tasks');
    if (!box) return;

    if (!taskList.length) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    box.style.display = 'block';

    // 表头（只建一次）
    let head = document.getElementById('tasks-head');
    if (!head) {
      head = document.createElement('div');
      head.id = 'tasks-head';
      head.className = 'tasks-head';
      head.textContent = '⬇ 后台下载（关闭弹窗不中断）';
      box.appendChild(head);
    }

    const seen = new Set();
    taskList.forEach((t) => {
      seen.add(t.taskId);
      let row = document.getElementById(`task-${t.taskId}`);
      const rowStatus = row ? row.dataset.status : null;

      if (row && rowStatus === t.status && t.status === 'running') {
        // 增量更新进度，避免整行重绘导致进度条闪烁
        const st = row.querySelector('.status-text');
        const fill = row.querySelector('.progress-fill');
        if (st) st.textContent = t.message || '';
        if (fill) fill.style.width = Math.min(Math.max(t.progress || 0, 0), 100) + '%';
      } else {
        if (row) row.remove();
        box.insertBefore(buildTaskRow(t), head.nextSibling); // 新任务置顶
      }
    });

    // 清掉已不存在的行
    box.querySelectorAll('.task-item').forEach((el) => {
      if (!seen.has(el.id.replace('task-', ''))) el.remove();
    });

    // 进行中的任务：联动媒体卡片（禁用按钮 + 恢复进度条显示）
    taskList.filter(t => t.status === 'running' && t.mediaId).forEach((t) => {
      setButtonsDisabled(t.mediaId, true);
      showProgress(t.mediaId, t.progress, t.message);
    });
  }

  function buildTaskRow(t) {
    const row = document.createElement('div');
    row.className = 'task-item' + (t.status !== 'running' ? ' task-' + t.status : '');
    row.id = `task-${t.taskId}`;
    row.dataset.status = t.status;

    const isRunning = t.status === 'running';
    const statusHtml = isRunning
      ? `<div class="status-text">${escapeHtml(t.message || '')}</div>
         <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(Math.max(t.progress || 0, 0), 100)}%"></div></div>`
      : `<div class="status-text">${escapeHtml(t.message || '')}</div>`;

    const actions = isRunning
      ? `<button class="btn-task-cancel" data-taskid="${t.taskId}" title="取消下载（需确认）">✕ 取消</button>`
      : `<button class="btn-task-dismiss" data-taskid="${t.taskId}">移除</button>`;

    row.innerHTML = `
      <div class="task-top">
        <span class="task-icon">${modeIcon(t)}</span>
        <span class="task-title" title="${escapeHtml(t.title || '')}">${escapeHtml(t.title || '下载任务')}</span>
        ${actions}
      </div>
      ${statusHtml}
      ${(t.status === 'error' && t.diagnostics)
        ? `<button class="btn-task-diag" data-taskid="${t.taskId}">📋 复制 Bug 报告</button>`
        : ''}
    `;

    row.querySelectorAll('[data-taskid]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.taskid;
        if (btn.classList.contains('btn-task-cancel')) cancelTask(id, btn);
        else if (btn.classList.contains('btn-task-dismiss')) dismissTask(id);
        else if (btn.classList.contains('btn-task-diag')) copyTaskDiag(id, btn);
      });
    });

    return row;
  }

  let cancelArmTimer = null;

  async function cancelTask(taskId, btn) {
    // 两段式确认（popup 中原生 confirm 会导致弹窗失焦自关，故用行内确认）：
    // 第一次点击进入"待确认"状态，3 秒内再次点击才真正取消。
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = '⚠ 确认取消？';
      btn.classList.add('armed');
      if (cancelArmTimer) clearTimeout(cancelArmTimer);
      cancelArmTimer = setTimeout(() => {
        btn.dataset.armed = '';
        btn.textContent = '✕ 取消';
        btn.classList.remove('armed');
      }, 3000);
      return;
    }
    if (cancelArmTimer) { clearTimeout(cancelArmTimer); cancelArmTimer = null; }
    btn.disabled = true;
    try {
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'CANCEL_DOWNLOAD',
        taskId,
      });
    } catch (e) {
      // offscreen 已不在（如浏览器重启），忽略
    }
    // 状态更新由 DOWNLOAD_PROGRESS 广播驱动；兜底延迟刷新
    setTimeout(refreshTasks, 800);
  }

  async function dismissTask(taskId) {
    try {
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'DISMISS_TASK',
        taskId,
      });
    } catch (e) {}
    taskList = taskList.filter(t => t.taskId !== taskId);
    renderTasks();
  }

  function copyTaskDiag(taskId, btn) {
    const t = taskList.find(x => x.taskId === taskId);
    if (!t || !t.diagnostics) return;
    const report = t.diagnostics.bugReport || JSON.stringify(t.diagnostics, null, 2);
    copyToClipboard(report).then(() => {
      btn.textContent = '✅ 已复制到剪贴板';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = '📋 复制 Bug 报告';
        btn.disabled = false;
      }, 2000);
    }).catch(() => {
      btn.textContent = '❌ 复制失败，请查看控制台';
      console.error('[VC] Bug 报告复制失败，内容如下：\n', report);
    });
  }

  // ==================== 下载处理 ====================
  async function handleDownloadVideo(media) {
    const qSelect = document.getElementById(`quality-${media.id}`);
    const qIndex = qSelect ? parseInt(qSelect.value) : (media.selectedQuality || 0);

    setButtonsDisabled(media.id, true);
    showProgress(media.id, 0, '准备下载...');

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'DOWNLOAD_VIDEO',
        mediaId: media.id,
        qualityIndex: qIndex,
      });
      if (resp && resp.error) {
        showProgress(media.id, -1, '❌ ' + resp.error);
        if (resp.diagnostics) showDiagnostics(media.id, resp.diagnostics);
        setButtonsDisabled(media.id, false);
      } else if (resp && resp.taskId) {
        showProgress(media.id, 1, '已加入后台下载，关闭弹窗不会中断');
      }
    } catch (e) {
      showProgress(media.id, -1, '❌ ' + e.message);
      setButtonsDisabled(media.id, false);
    }
  }

  async function handleDownloadAudio(media) {
    const fmtSelect = document.getElementById(`audiofmt-${media.id}`);
    const val = fmtSelect ? fmtSelect.value : 'mp3-320';
    const qSelect = document.getElementById(`quality-${media.id}`);
    const qIndex = qSelect ? parseInt(qSelect.value) : (media.selectedQuality || 0);

    let format, bitrate;
    if (val.startsWith('mp3-')) {
      format = 'mp3';
      bitrate = parseInt(val.split('-')[1]);
    } else {
      format = val;
      bitrate = 0;
    }

    setButtonsDisabled(media.id, true);
    showProgress(media.id, 0, '准备提取音频...');

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'DOWNLOAD_AUDIO',
        mediaId: media.id,
        format: format,
        bitrate: bitrate,
        qualityIndex: qIndex,
      });
      if (resp && resp.error) {
        showProgress(media.id, -1, '❌ ' + resp.error);
        if (resp.diagnostics) showDiagnostics(media.id, resp.diagnostics);
        setButtonsDisabled(media.id, false);
      } else if (resp && resp.taskId) {
        showProgress(media.id, 1, '已加入后台下载，关闭弹窗不会中断');
      }
    } catch (e) {
      showProgress(media.id, -1, '❌ ' + e.message);
      setButtonsDisabled(media.id, false);
    }
  }

  // ==================== 进度更新 ====================
  // 消息来自 offscreen 下载引擎（DOWNLOAD_PROGRESS 广播），
  // 同时更新顶部任务区与媒体卡片内进度。
  function handleProgressUpdate(message) {
    if (message.taskId) {
      const t = taskList.find(x => x.taskId === message.taskId);
      if (t) {
        Object.assign(t, message);
      } else {
        taskList.unshift(message); // 新任务置顶
      }
      renderTasks();
    }

    if (!message.mediaId) return;

    if (message.status === 'error') {
      showProgress(message.mediaId, -1, '❌ ' + (message.error || message.message));
      if (message.diagnostics) showDiagnostics(message.mediaId, message.diagnostics);
      setButtonsDisabled(message.mediaId, false);
    } else if (message.status === 'cancelled') {
      showProgress(message.mediaId, -1, '⏹ 已取消');
      setButtonsDisabled(message.mediaId, false);
    } else if (message.status === 'done') {
      showProgress(message.mediaId, 100, '✅ ' + (message.message || '下载完成'));
      setTimeout(() => setButtonsDisabled(message.mediaId, false), 1000);
    } else {
      showProgress(message.mediaId, message.progress, message.message);
    }
  }

  function showProgress(mediaId, progress, message) {
    const cardId = resolveCardId(mediaId);
    const progSection = document.getElementById(`prog-${cardId}`);
    if (!progSection) return;
    progSection.style.display = 'block';

    const status = document.getElementById(`status-${cardId}`);
    const fill = document.getElementById(`fill-${cardId}`);

    if (status) status.textContent = message || '';

    if (progress >= 0) {
      if (fill) fill.style.width = Math.min(progress, 100) + '%';
    } else {
      // 错误状态
      if (fill) fill.style.width = '100%';
      if (fill) fill.style.background = '#e74c3c';
    }
  }

  function setButtonsDisabled(mediaId, disabled) {
    const cardId = resolveCardId(mediaId);
    const vBtn = document.getElementById(`dlvideo-${cardId}`);
    const aBtn = document.getElementById(`dlaudio-${cardId}`);
    const mBtn = document.getElementById(`dlmerge-${cardId}`);
    if (vBtn) vBtn.disabled = disabled;
    if (aBtn) aBtn.disabled = disabled;
    if (mBtn) mBtn.disabled = disabled;
  }

  // ==================== 错误诊断面板 + Bug 报告 ====================

  function codecNameShort(fourcc) {
    const c = (fourcc || '').toLowerCase();
    if (c.startsWith('avc1') || c.startsWith('avc3')) return 'H.264';
    if (c.startsWith('hev1') || c.startsWith('hvc1')) return 'H.265';
    if (c.startsWith('av01')) return 'AV1';
    if (c.startsWith('vp09')) return 'VP9';
    if (c.startsWith('mp4a')) return 'AAC';
    if (c.startsWith('flac')) return 'FLAC';
    if (c.startsWith('opus')) return 'Opus';
    if (c.startsWith('ec-3')) return 'E-AC-3';
    return fourcc || '未知';
  }

  function copyToClipboard(text) {
    // 优先用现代 Clipboard API，失败则降级到 execCommand
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve();
        else reject(new Error('execCommand 返回 false'));
      } catch (e) { reject(e); }
    });
  }

  // 在卡片下方渲染诊断摘要 + "复制 Bug 报告"按钮
  function showDiagnostics(mediaId, diagnostics) {
    const cardId = resolveCardId(mediaId);
    const card = document.getElementById(`card-${cardId}`);
    if (!card || !diagnostics) return;

    // 移除旧诊断面板（同一卡片重复出错时覆盖）
    const old = document.getElementById(`diag-${cardId}`);
    if (old) old.remove();

    const panel = document.createElement('div');
    panel.id = `diag-${cardId}`;
    panel.style.cssText = 'margin-top:8px;padding:10px 12px;background:#fff8e1;border:1px solid #ffca28;border-radius:8px;font-size:11px;color:#5d4037;line-height:1.5;';

    // 摘要：codec 检测 + 文件类型 + 第一条建议
    const codecStr = diagnostics.codecs && diagnostics.codecs.length
      ? diagnostics.codecs.map(c => `${c} (${codecNameShort(c)})`).join(', ')
      : '未识别';
    const suggestion = (diagnostics.suggestions && diagnostics.suggestions[0]) || '已生成诊断报告';
    const videoErr = diagnostics.videoError
      ? `${diagnostics.videoError.codeName} (code=${diagnostics.videoError.code})`
      : '未触发';

    panel.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px;color:#e65100;">🔍 自动诊断</div>
      <div>检测到 codec：<b>${escapeHtml(codecStr)}</b></div>
      <div>视频元素错误：<b>${escapeHtml(videoErr)}</b></div>
      <div>fragmented MP4：${diagnostics.isFMP4 ? '是' : '否'}</div>
      <div style="margin:4px 0;color:#bf360c;">${escapeHtml(suggestion)}</div>
      <button class="btn btn-secondary" id="diagbtn-${cardId}"
        style="margin-top:6px;padding:5px 10px;font-size:11px;flex:none;">📋 复制 Bug 报告</button>`;

    card.appendChild(panel);

    const btn = document.getElementById(`diagbtn-${cardId}`);
    if (btn) {
      btn.addEventListener('click', () => {
        const report = diagnostics.bugReport || JSON.stringify(diagnostics, null, 2);
        copyToClipboard(report).then(() => {
          btn.textContent = '✅ 已复制到剪贴板';
          btn.disabled = true;
          setTimeout(() => {
            btn.textContent = '📋 复制 Bug 报告';
            btn.disabled = false;
          }, 2000);
        }).catch(() => {
          btn.textContent = '❌ 复制失败，请查看控制台';
          console.error('[VC] Bug 报告复制失败，内容如下：\n', report);
        });
      });
    }
  }

  // ==================== 辅助函数 ====================
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function formatDuration(sec) {
    if (!sec || sec <= 0) return '--:--';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function badgeClass(media) {
    if (media.source === 'bilibili') return 'badge-bilibili';
    if (media.source === 'douyin') return 'badge-douyin';
    if (media.type === 'hls') return 'badge-hls';
    if (media.type === 'dash' || media.type === 'dash-video' || media.type === 'dash-audio') return 'badge-dash';
    return 'badge-direct';
  }

  function badgeText(media) {
    if (media.source === 'bilibili') return 'B站';
    if (media.source === 'douyin') return '抖音';
    if (media.type === 'hls') return 'HLS';
    if (media.type === 'dash-video') return 'DASH视频流';
    if (media.type === 'dash-audio') return 'DASH音频流';
    if (media.type === 'dash') return 'DASH';
    return '直接链接';
  }

  function canPreview(media) {
    if (media.type === 'hls') return false;
    if (media.type === 'blob') return false;
    if (media.url.startsWith('blob:')) return false;
    if (media.type === 'dash-audio') {
      // 音频流可以试播
      return true;
    }
    // 直接 URL 和 DASH 视频流尝试预览
    return media.url.startsWith('http');
  }

  function getPreviewNote(media) {
    if (media.type === 'hls') return ' HLS 流，下载后查看';
    if (media.type === 'blob') return ' Blob URL，请直接下载';
    if (media.url.startsWith('blob:')) return ' Blob URL，请直接下载';
    return ' 预览不可用，请直接下载';
  }

  function canDownloadVideo(media) {
    if (media.type === 'dash-audio') return false; // 音频流没有视频
    if (media.type === 'blob') return false;
    if (media.url.startsWith('blob:')) return false;
    return true;
  }

  function canDownloadAudio(media) {
    if (media.type === 'dash-video') return false; // 视频流没有音频（B站DASH）
    if (media.type === 'blob') return false;
    if (media.url.startsWith('blob:')) return false;
    return true;
  }
})();
