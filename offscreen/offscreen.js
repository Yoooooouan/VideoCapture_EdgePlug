/**
 * offscreen/offscreen.js
 * 离屏文档：后台下载引擎 + 音频提取与编码
 * 1. 后台下载任务常驻本文档执行（popup 关闭 / Service Worker 被闲置回收均不影响）
 * 2. 只有用户在 popup 中明确确认取消（CANCEL_DOWNLOAD）才会中止任务
 * 3. 音频提取：decodeAudioData 快速解码，失败时 video 元素实时提取
 * 4. 编码为 MP3 (lamejs) 或 WAV (原生)
 */

(function () {
  'use strict';

  // ==================== 视频解码诊断工具 ====================
  // 出错时自动收集 codec / 浏览器支持 / video.error 详情，
  // 生成可直接提交给开发者的 markdown Bug 报告。

  // 解析 ISO BMFF (MP4/fMP4) 盒子，从 stsd 中提取 codec 四字符码。
  // B站 m4s baseUrl 通常是带 moov 的完整 fMP4，可解析。
  function detectCodecFromMP4(buffer) {
    const u8 = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const found = new Set();
    const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'mvex', 'moof', 'traf']);

    function readBox(pos, end, depth) {
      if (depth > 8) return;
      while (pos + 8 <= end) {
        let size = view.getUint32(pos, false);
        const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
        let headerSize = 8;
        if (size === 1) {
          if (pos + 16 > end) return;
          const hi = view.getUint32(pos + 8, false);
          const lo = view.getUint32(pos + 12, false);
          size = hi * 0x100000000 + lo;
          headerSize = 16;
        } else if (size === 0) {
          size = end - pos;
        }
        if (size < 8) return;
        const bodyStart = pos + headerSize;
        const bodyEnd = Math.min(pos + size, end);

        if (type === 'stsd') {
          // stsd: version(1) + flags(3) + entry_count(4) + entries
          if (bodyStart + 8 <= bodyEnd) {
            const entryCount = view.getUint32(bodyStart + 4, false);
            let ep = bodyStart + 8;
            for (let i = 0; i < entryCount && ep + 8 <= bodyEnd; i++) {
              const esize = view.getUint32(ep, false);
              const codec = String.fromCharCode(u8[ep + 4], u8[ep + 5], u8[ep + 6], u8[ep + 7]);
              if (/^[a-zA-Z0-9. -]{4}$/.test(codec)) found.add(codec);
              if (esize < 8) break;
              ep += esize;
            }
          }
        } else if (CONTAINERS.has(type)) {
          readBox(bodyStart, bodyEnd, depth + 1);
        }
        pos += size;
      }
    }

    try {
      // 只扫前 10MB，避免大文件阻塞
      readBox(0, Math.min(buffer.byteLength, 10 * 1024 * 1024), 0);
    } catch (e) {}
    return [...found];
  }

  // 检测浏览器对各类 codec 的支持情况（canPlayType + MediaSource.isTypeSupported）
  function checkCodecSupport() {
    const results = {};
    const video = document.createElement('video');
    const tests = [
      ['avc1', 'video/mp4; codecs="avc1.42E01E"'],
      ['avc3', 'video/mp4; codecs="avc3.42E01E"'],
      ['hev1', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
      ['hvc1', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
      ['av01', 'video/mp4; codecs="av01.0.05M.08"'],
      ['vp9',  'video/webm; codecs="vp9"'],
      ['mp4a', 'audio/mp4; codecs="mp4a.40.2"'],
      ['fLaC', 'audio/mp4; codecs="fLaC"'],
      ['Opus', 'audio/mp4; codecs="Opus"'],
    ];
    for (const [name, mime] of tests) {
      try { results[name] = video.canPlayType(mime) || 'no'; } catch (e) { results[name] = 'error'; }
    }
    results._MediaSource = typeof MediaSource !== 'undefined';
    if (results._MediaSource) {
      for (const [name, mime] of tests) {
        try { results['MS_' + name] = MediaSource.isTypeSupported(mime); } catch (e) { results['MS_' + name] = 'error'; }
      }
    }
    return results;
  }

  function describeVideoError(videoEl) {
    const err = videoEl && videoEl.error;
    if (!err) return null;
    const codeMap = {
      1: 'MEDIA_ERR_ABORTED',
      2: 'MEDIA_ERR_NETWORK',
      3: 'MEDIA_ERR_DECODE',
      4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
    };
    return {
      code: err.code,
      codeName: codeMap[err.code] || 'UNKNOWN',
      message: err.message || '',
    };
  }

  function bufferToHex(buffer, maxBytes) {
    const u8 = new Uint8Array(buffer);
    const n = Math.min(u8.length, maxBytes || 64);
    let s = '';
    for (let i = 0; i < n; i++) {
      s += u8[i].toString(16).padStart(2, '0') + ' ';
      if ((i + 1) % 16 === 0) s += '\n';
    }
    return s.trim();
  }

  // 检测是否 fragmented MP4：含 styp/sidx/moof 任一即认为是
  function detectFMP4(buffer) {
    const u8 = new Uint8Array(buffer);
    const len = Math.min(u8.length, 1024 * 1024);
    const tags = ['styp', 'sidx', 'moof'];
    const text = [];
    for (let i = 0; i < len; i++) text.push(String.fromCharCode(u8[i]));
    const head = text.join('');
    return tags.some(t => head.includes(t));
  }

  function codecName(fourcc) {
    const c = (fourcc || '').toLowerCase();
    if (c.startsWith('avc1') || c.startsWith('avc3')) return 'H.264';
    if (c.startsWith('hev1') || c.startsWith('hvc1')) return 'H.265 (HEVC)';
    if (c.startsWith('av01')) return 'AV1';
    if (c.startsWith('vp09')) return 'VP9';
    if (c.startsWith('mp4a')) return 'AAC';
    if (c.startsWith('flac')) return 'FLAC';
    if (c.startsWith('opus')) return 'Opus';
    if (c.startsWith('ec-3')) return 'E-AC-3';
    return fourcc;
  }

  // 基于诊断结果给出可执行的修复建议
  function generateSuggestions(codecs, support, scenario) {
    const s = [];
    const videoCodecs = (codecs || []).filter(c => !/^(mp4a|flac|opus|ec-3)/i.test(c));
    const hasHEVC = videoCodecs.some(c => /hev1|hvc1/i.test(c));
    const hasAV1 = videoCodecs.some(c => /av01/i.test(c));
    const hasAVC = videoCodecs.some(c => /avc1|avc3/i.test(c));

    if (hasHEVC && support.hev1 === '' && !support._MediaSourceHandled) {
      s.push('⚠️ 检测到 H.265 (HEVC) 视频流，Chrome 默认不解 HEVC。');
      s.push('   → 请在清晰度下拉中切换到标注 (H.264) 的选项；4K 可能仅有 H.265，无法播放。');
    } else if (hasHEVC) {
      s.push('⚠️ 检测到 H.265 (HEVC) 视频流，当前浏览器不支持硬解。');
      s.push('   → 切换到 H.264 清晰度；或在 Chrome 地址栏访问 chrome://flags/#enable-experimental-web-platform-features 排查。');
    }
    if (hasAV1 && support.av01 === '') {
      s.push('⚠️ 检测到 AV1 视频流，当前 Chrome 不解 AV1。');
      s.push('   → 切换到 H.264/H.265 清晰度。');
    }
    if (!hasAVC && (hasHEVC || hasAV1)) {
      s.push('ℹ️ 该清晰度未提供 H.264 版本，Chrome 几乎必然无法解码。');
    }
    if (videoCodecs.length === 0) {
      s.push('⚠️ 未从视频流中识别出任何视频 codec，可能不是有效的 MP4/fMP4 文件。');
      s.push('   → 检查下载链接是否完整（B站 m4s 的 baseUrl 应包含 init segment）。');
    }
    if (s.length === 0) {
      s.push('ℹ️ 未识别出明确的 codec 兼容性问题，可能是 fragmented MP4 缺失 init segment 或文件损坏。');
    }
    return s;
  }

  function formatBytes(n) {
    if (!n && n !== 0) return 'unknown';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  // 生成可直接提交的 markdown Bug 报告
  function generateBugReport(ctx) {
    const lines = [];
    lines.push('## Bug 报告：视频解码失败（格式不支持）');
    lines.push('');
    lines.push('### 错误概述');
    lines.push('- 错误信息：' + (ctx.error || '视频解码失败'));
    lines.push('- 发生时间：' + new Date().toISOString());
    lines.push('- 操作场景：' + (ctx.scenario || 'unknown'));
    lines.push('');
    lines.push('### 环境信息');
    lines.push('- UserAgent：' + navigator.userAgent);
    lines.push('- 平台：' + navigator.platform);
    lines.push('- 扩展版本：1.0.0 (VideoCapture_EdgePlug)');
    lines.push('- 来源页面：' + (ctx.pageUrl || '(请补充)'));
    lines.push('');
    lines.push('### 媒体信息');
    if (ctx.videoUrl) {
      // 音频提取场景下源流可能是音频流，标签需对应
      const isAudioOnly = ctx.scenario === 'extract-audio' && !ctx.audioUrl;
      const urlLabel = isAudioOnly ? '源流 URL' : '视频流 URL';
      const sizeLabel = isAudioOnly ? '源流大小' : '视频流大小';
      lines.push(`- ${urlLabel}：${ctx.videoUrl}`);
      lines.push(`- ${sizeLabel}：${formatBytes(ctx.videoSize)}`);
    }
    if (ctx.audioUrl) {
      lines.push('- 音频流 URL：' + ctx.audioUrl);
      lines.push('- 音频流大小：' + formatBytes(ctx.audioSize));
    }
    if (ctx.qualityLabel) lines.push('- 选中清晰度：' + ctx.qualityLabel);
    lines.push('');
    lines.push('### 文件头分析');
    lines.push('- 检测到 codec：' + (ctx.codecs && ctx.codecs.length ? ctx.codecs.map(c => `${c} (${codecName(c)})`).join(', ') : '未识别'));
    lines.push('- 是否 fragmented MP4：' + (ctx.isFMP4 ? '是' : '否'));
    lines.push('- 文件头(hex)：');
    lines.push('```');
    lines.push(ctx.headerHex || '(空)');
    lines.push('```');
    lines.push('');
    lines.push('### 视频元素错误详情');
    if (ctx.videoError) {
      lines.push('- error.code：' + ctx.videoError.code + ' (' + ctx.videoError.codeName + ')');
      lines.push('- error.message：' + (ctx.videoError.message || '(空)'));
    } else {
      lines.push('- (video.error 为空，可能 loadedmetadata 阶段即失败)');
    }
    lines.push('');
    lines.push('### 浏览器 codec 支持检测');
    for (const [k, v] of Object.entries(ctx.support || {})) {
      lines.push('- ' + k + '：' + v);
    }
    lines.push('');
    lines.push('### 自动诊断建议');
    for (const sug of (ctx.suggestions || [])) lines.push(sug);
    lines.push('');
    lines.push('### 复现步骤');
    let step = 1;
    lines.push(`${step++}. 打开 ${ctx.pageUrl || '(请补充页面 URL)'}`);
    lines.push(`${step++}. 点击浏览器工具栏的"视频抓取助手"扩展图标`);
    if (ctx.qualityLabel) lines.push(`${step++}. 在清晰度下拉中选择「${ctx.qualityLabel}」`);
    lines.push(`${step++}. 点击「下载视频+音频（推荐）」按钮`);
    lines.push(`${step++}. 等待数秒后弹出"视频解码失败（格式不支持）"错误`);
    lines.push('');
    lines.push('---');
    lines.push('请将以上内容复制提交到 Issue，开发者会根据 codec 检测与浏览器支持情况定位问题。');
    return lines.join('\n');
  }

  // 组装诊断对象 + 带 diagnostics 的 Error
  function buildDecodeError(videoBuffer, videoEl, scenario, extra) {
    const codecs = detectCodecFromMP4(videoBuffer);
    const support = checkCodecSupport();
    const videoError = describeVideoError(videoEl);
    const headerHex = bufferToHex(videoBuffer, 64);
    const isFMP4 = detectFMP4(videoBuffer);
    const suggestions = generateSuggestions(codecs, support, scenario);
    const diagnostics = {
      error: '视频解码失败（格式不支持）',
      scenario,
      codecs,
      support,
      videoError,
      headerHex,
      isFMP4,
      videoSize: videoBuffer ? videoBuffer.byteLength : 0,
      suggestions,
      pageUrl: (extra && extra.pageUrl) || '',
      videoUrl: (extra && extra.videoUrl) || '',
      audioUrl: (extra && extra.audioUrl) || '',
      audioSize: (extra && extra.audioSize) || 0,
      qualityLabel: (extra && extra.qualityLabel) || '',
    };
    diagnostics.bugReport = generateBugReport(diagnostics);
    const err = new Error('视频解码失败（格式不支持）');
    err.diagnostics = diagnostics;
    return err;
  }

  // ==================== WAV 编码器 ====================

  function encodeWAV(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const numFrames = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;

    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF header
    writeStr(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(view, 8, 'WAVE');

    // fmt chunk
    writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // 16-bit

    // data chunk
    writeStr(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // PCM 样本
    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const s = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  function writeStr(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // ==================== MP3 编码器 (lamejs) ====================

  function encodeMP3(audioBuffer, kbps) {
    const numChannels = Math.min(audioBuffer.numberOfChannels, 2); // 最多双声道
    const sampleRate = audioBuffer.sampleRate;
    const mp3encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, kbps || 320);

    // 获取 int16 样本
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      const int16 = new Int16Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const s = Math.max(-1, Math.min(1, data[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      channels.push(int16);
    }

    // 如果原始是多声道但只有1路，取第1路
    if (numChannels === 1 && audioBuffer.numberOfChannels > 1) {
      // 已经处理
    }

    const data = [];
    const blockSize = 1152; // MP3 帧大小
    const totalSamples = channels[0].length;

    for (let i = 0; i < totalSamples; i += blockSize) {
      let mp3buf;
      const end = Math.min(i + blockSize, totalSamples);
      if (numChannels === 1) {
        mp3buf = mp3encoder.encodeBuffer(channels[0].subarray(i, end));
      } else {
        const left = channels[0].subarray(i, end);
        const right = channels[1].subarray(i, end);
        mp3buf = mp3encoder.encodeBuffer(left, right);
      }
      if (mp3buf.length > 0) {
        data.push(new Int8Array(mp3buf));
      }
    }

    const flush = mp3encoder.flush();
    if (flush.length > 0) {
      data.push(new Int8Array(flush));
    }

    return new Blob(data, { type: 'audio/mp3' });
  }

  // ==================== 快速解码（decodeAudioData） ====================

  async function tryFastDecode(arrayBuffer) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      ctx.close();
      return audioBuffer;
    } catch (e) {
      console.log('[VC-Offscreen] 快速解码失败，尝试实时提取:', e.message);
      return null;
    }
  }

  // ==================== 实时音频提取（video 元素） ====================

  function captureAudioFromVideo(arrayBuffer, mimeType, ctx, signal) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([arrayBuffer], { type: mimeType || 'video/mp4' });
      const blobUrl = URL.createObjectURL(blob);
      const video = document.getElementById('hidden-video');

      video.src = blobUrl;
      video.muted = true;
      video.playbackRate = 1.0;

      let audioContext = null;
      let source = null;
      let processor = null;
      let muteGain = null;
      const channelData = [];
      let numChannels = 2;
      let sampleRate = 44100;
      let started = false;

      const cleanup = () => {
        try {
          if (source) source.disconnect();
          if (processor) processor.disconnect();
          if (muteGain) muteGain.disconnect();
          if (audioContext) audioContext.close();
        } catch (e) {}
        URL.revokeObjectURL(blobUrl);
        video.src = '';
      };

      const onLoadedMetadata = () => {
        if (started) return;
        started = true;

        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          audioContext = new AC();
          sampleRate = audioContext.sampleRate;
          source = audioContext.createMediaElementSource(video);
          processor = audioContext.createScriptProcessor(8192, 2, 2);

          processor.onaudioprocess = (e) => {
            const input = e.inputBuffer;
            numChannels = input.numberOfChannels;
            for (let ch = 0; ch < numChannels; ch++) {
              if (!channelData[ch]) channelData[ch] = [];
              channelData[ch].push(new Float32Array(input.getChannelData(ch)));
            }
          };

          // 连接音频图（静音输出）
          source.connect(processor);
          muteGain = audioContext.createGain();
          muteGain.gain.value = 0;
          processor.connect(muteGain);
          muteGain.connect(audioContext.destination);

          video.play().catch((e) => {
            cleanup();
            reject(new Error('视频播放失败: ' + e.message));
          });
        } catch (e) {
          cleanup();
          reject(new Error('音频图创建失败: ' + e.message));
        }
      };

      const onEnded = () => {
        // 合并所有 chunk
        const finalChannels = [];
        for (let ch = 0; ch < numChannels; ch++) {
          const chunks = channelData[ch] || [];
          const total = chunks.reduce((sum, arr) => sum + arr.length, 0);
          finalChannels[ch] = new Float32Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            finalChannels[ch].set(chunk, offset);
            offset += chunk.length;
          }
        }

        // 构建 AudioBuffer
        const length = finalChannels[0]?.length || 0;
        if (length === 0) {
          cleanup();
          reject(new Error('未捕获到音频数据'));
          return;
        }

        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx2 = new AC();
        const audioBuffer = ctx2.createBuffer(numChannels, length, sampleRate);
        for (let ch = 0; ch < numChannels; ch++) {
          audioBuffer.copyToChannel(finalChannels[ch], ch);
        }
        ctx2.close();

        cleanup();
        resolve(audioBuffer);
      };

      const onError = (e) => {
        // 出错时自动检测 codec / 浏览器支持 / video.error，生成可提交的 Bug 报告
        const err = buildDecodeError(arrayBuffer, video, 'extract-audio', ctx || {});
        cleanup();
        reject(err);
      };

      video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
      video.addEventListener('ended', onEnded, { once: true });
      video.addEventListener('error', onError, { once: true });

      // 用户确认取消：中止实时提取
      if (signal) {
        signal.addEventListener('abort', () => {
          try { video.pause(); } catch (e) {}
          cleanup();
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
      }

      // 超时保护（30分钟）
      setTimeout(() => {
        if (!started) {
          cleanup();
          reject(new Error('超时：无法加载视频'));
        }
      }, 30 * 60 * 1000);
    });
  }

  // ==================== 快速音视频合并（fMP4 无重编码 remux） ====================
  // B站 DASH 的视频/音频 m4s 是自包含 fragmented MP4（moov + moof/mdat）。
  // 通过盒级拼接 + track_id 重写把两路独立 fMP4 合成单文件：
  //   不解码、不重编码、不实时播放 → 合并耗时≈内存拷贝（秒级），
  //   远快于 MediaRecorder 实时录制（旧实现耗时≈视频时长且重编码）。
  // 非 fMP4 / 结构异常输入会抛错，由调用方回退到 MediaRecorder 实时录制。

  // 读取 box type（4 字符 ASCII，big-endian）
  function _boxType(u8, off) {
    return String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
  }

  // 解析 [start,end) 范围内的顶层盒子，offset/size 均为相对所属 buffer 的绝对偏移
  function _parseBoxes(u8, start, end) {
    const boxes = [];
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let pos = start;
    while (pos + 8 <= end) {
      let size = dv.getUint32(pos, false); // big-endian
      const type = _boxType(u8, pos);
      let hs = 8;
      if (size === 1) { // 64-bit largesize
        if (pos + 16 > end) break;
        const hi = dv.getUint32(pos + 8, false);
        const lo = dv.getUint32(pos + 12, false);
        size = hi * 0x100000000 + lo;
        hs = 16;
      } else if (size === 0) { // 到文件尾
        size = end - pos;
      }
      if (size < 8 || pos + size > end) break;
      boxes.push({ type, offset: pos, size, headerSize: hs, dataStart: pos + hs, dataEnd: pos + size });
      pos += size;
    }
    return boxes;
  }

  function _findBox(boxes, type) {
    for (let i = 0; i < boxes.length; i++) if (boxes[i].type === type) return boxes[i];
    return null;
  }

  // 返回 trak 内 tkhd 的 track_id 字段绝对偏移与当前值
  function _tkhdTidField(u8, trak) {
    const ch = _parseBoxes(u8, trak.dataStart, trak.dataEnd);
    const tkhd = _findBox(ch, 'tkhd');
    if (!tkhd) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const version = u8[tkhd.dataStart];
    // fullbox: version(1)+flags(3)，之后 creation_time + modification_time
    // v0: 各 4 字节；v1: 各 8 字节
    const off = tkhd.dataStart + 4 + (version === 1 ? 16 : 8);
    return { offset: off, value: dv.getUint32(off, false) };
  }

  // 返回 moof → traf → tfhd 的 {tidOffset, flags, baseOffRel}
  //   flags: 判断 base-data-offset(0x01) / default-base-is-moof(0x020000)
  //   baseOffRel: base-data-offset 字段相对 moof 起点的偏移（仅在存在时有效）
  function _tfhdInfo(u8, moof) {
    const mc = _parseBoxes(u8, moof.dataStart, moof.dataEnd);
    const traf = _findBox(mc, 'traf');
    if (!traf) return null;
    const tc = _parseBoxes(u8, traf.dataStart, traf.dataEnd);
    const tfhd = _findBox(tc, 'tfhd');
    if (!tfhd) return null;
    // fullbox: version(1 byte) + flags(3 bytes)
    const flags = (u8[tfhd.dataStart + 1] << 16) | (u8[tfhd.dataStart + 2] << 8) | u8[tfhd.dataStart + 3];
    const tidOffset = tfhd.dataStart + 4; // track_id 紧跟 version+flags
    let baseOffRel = -1;
    if (flags & 0x01) { // base-data-offset present（8 字节绝对偏移，紧跟 track_id）
      baseOffRel = (tfhd.dataStart + 8) - moof.offset;
    }
    return { tidOffset, flags, baseOffRel };
  }

  // 收集顶层盒子中的 moof/mdat 对（保持顺序，跳过 styp/sidx/mfra）
  function _collectFrags(top) {
    const frags = [];
    let pend = null;
    for (let i = 0; i < top.length; i++) {
      const b = top[i];
      if (b.type === 'moof') {
        pend = b;
      } else if (b.type === 'mdat' && pend) {
        frags.push({ moof: pend, mdat: b });
        pend = null;
      }
    }
    return frags;
  }

  async function fastRemuxMP4(videoBuffer, audioBuffer, ctx, report) {
    const vu = new Uint8Array(videoBuffer);
    const au = new Uint8Array(audioBuffer);

    const vTop = _parseBoxes(vu, 0, vu.length);
    const aTop = _parseBoxes(au, 0, au.length);
    const vMoov = _findBox(vTop, 'moov');
    const aMoov = _findBox(aTop, 'moov');
    if (!vMoov || !aMoov) throw new Error('快速合并需要 fragmented MP4（缺少 moov）');

    const vMC = _parseBoxes(vu, vMoov.dataStart, vMoov.dataEnd);
    const aMC = _parseBoxes(au, aMoov.dataStart, aMoov.dataEnd);
    const vTrak = _findBox(vMC, 'trak');
    const aTrak = _findBox(aMC, 'trak');
    const vMvhd = _findBox(vMC, 'mvhd');
    const vMvex = _findBox(vMC, 'mvex');
    const aMvex = _findBox(aMC, 'mvex');
    if (!vTrak || !aTrak || !vMvhd || !vMvex || !aMvex) throw new Error('moov 结构不完整（缺 trak/mvhd/mvex）');

    const vTidF = _tkhdTidField(vu, vTrak);
    const aTidF = _tkhdTidField(au, aTrak);
    if (!vTidF || !aTidF) throw new Error('无法读取 track_id');
    const V_TID = vTidF.value;
    const A_TID = aTidF.value;
    const VIDEO_TID = 1;
    const AUDIO_TID = 2;

    const vMvexCh = _parseBoxes(vu, vMvex.dataStart, vMvex.dataEnd);
    const vTrex = _findBox(vMvexCh, 'trex');
    const aMvexCh = _parseBoxes(au, aMvex.dataStart, aMvex.dataEnd);
    const aTrex = _findBox(aMvexCh, 'trex');
    if (!vTrex || !aTrex) throw new Error('缺少 trex（非 fragmented MP4）');

    const vFtyp = _findBox(vTop, 'ftyp');
    if (!vFtyp) throw new Error('缺少 ftyp');

    const vFrags = _collectFrags(vTop);
    const aFrags = _collectFrags(aTop);
    if (!vFrags.length) throw new Error('视频流无 moof/mdat 分片（可能为渐进式 MP4）');
    if (!aFrags.length) throw new Error('音频流无 moof/mdat 分片');

    // 预检 tfhd base 模式：仅支持 default-base-is-moof(0x020000) 或 base-data-offset(0x01)，
    // 其余（base=0 绝对）移动 moof 后会失效 → 抛错走兜底
    const checkFrags = (frags, u8) => {
      for (const f of frags) {
        const ti = _tfhdInfo(u8, f.moof);
        if (!ti) throw new Error('moof 缺少 tfhd');
        if (!((ti.flags & 0x020000) || (ti.flags & 0x01))) {
          throw new Error('不支持的 tfhd base 模式');
        }
      }
    };
    checkFrags(vFrags, vu);
    checkFrags(aFrags, au);

    // ---- 计算输出总大小 ----
    const moovBodyLen = vMvhd.size + vTrak.size + aTrak.size + (8 + vTrex.size + aTrex.size);
    const moovLen = 8 + moovBodyLen;
    const STYP_LEN = 16; // 段类型标记，提升兼容性
    let total = vFtyp.size + moovLen + STYP_LEN;
    for (const f of vFrags) total += f.moof.size + f.mdat.size;
    for (const f of aFrags) total += f.moof.size + f.mdat.size;

    report(60, '正在合并音视频轨道（无重编码）...');

    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    let w = 0;
    // 返回写入起点，便于打补丁
    function emit(u8, off, len) {
      const s = w;
      out.set(u8.subarray(off, off + len), s);
      w += len;
      return s;
    }
    const patch32 = (absOff, val) => dv.setUint32(absOff, val, false);
    const patch64 = (absOff, val) => {
      dv.setUint32(absOff, Math.floor(val / 0x100000000) >>> 0, false);
      dv.setUint32(absOff + 4, val >>> 0, false);
    };

    // 1) ftyp（沿用视频流的 brand，兼容 avc1/hevc）
    emit(vu, vFtyp.offset, vFtyp.size);

    // 2) moov：mvhd + video trak + audio trak + mvex(trex×2)
    const moovStart = w;
    patch32(w, moovLen);
    out[w + 4] = 0x6d; out[w + 5] = 0x6f; out[w + 6] = 0x6f; out[w + 7] = 0x76; // 'moov'
    w += 8;

    // mvhd（拷贝视频 mvhd，修正 next_track_ID = 3）
    {
      const s = emit(vu, vMvhd.offset, vMvhd.size);
      patch32(s + vMvhd.size - 4, 3);
    }
    // video trak（拷贝；track_id 不为 1 时改写）
    {
      const s = emit(vu, vTrak.offset, vTrak.size);
      if (V_TID !== VIDEO_TID) patch32(s + (vTidF.offset - vTrak.offset), VIDEO_TID);
    }
    // audio trak（拷贝；track_id 改写为 2）
    {
      const s = emit(au, aTrak.offset, aTrak.size);
      patch32(s + (aTidF.offset - aTrak.offset), AUDIO_TID);
    }
    // mvex：8 头 + video trex + audio trex
    {
      const mvexLen = 8 + vTrex.size + aTrex.size;
      patch32(w, mvexLen);
      out[w + 4] = 0x6d; out[w + 5] = 0x76; out[w + 6] = 0x65; out[w + 7] = 0x78; // 'mvex'
      w += 8;
      const vs = emit(vu, vTrex.offset, vTrex.size);
      if (V_TID !== VIDEO_TID) patch32(vs + ((vTrex.dataStart + 4) - vTrex.offset), VIDEO_TID);
      const as = emit(au, aTrex.offset, aTrex.size);
      patch32(as + ((aTrex.dataStart + 4) - aTrex.offset), AUDIO_TID);
    }

    // 3) styp 段标记（major 'msdh'）
    out.set([0, 0, 0, 0x10, 0x73, 0x74, 0x79, 0x70, 0x6d, 0x73, 0x64, 0x68, 0, 0, 0, 0], w);
    w += STYP_LEN;

    report(80, '正在写入媒体分片...');

    // 4) 分片：先视频后音频。每个 moof 紧跟其 mdat，trun data_offset 相对 moof 起点仍有效。
    const emitFrags = (u8, frags, fromTid, toTid) => {
      for (const f of frags) {
        const moofOutStart = emit(u8, f.moof.offset, f.moof.size);
        const ti = _tfhdInfo(u8, f.moof);
        if (ti) {
          if (fromTid !== toTid) patch32(moofOutStart + (ti.tidOffset - f.moof.offset), toTid);
          if (ti.baseOffRel >= 0) patch64(moofOutStart + ti.baseOffRel, moofOutStart);
        }
        emit(u8, f.mdat.offset, f.mdat.size);
      }
    };
    emitFrags(vu, vFrags, V_TID, VIDEO_TID);
    emitFrags(au, aFrags, A_TID, AUDIO_TID);

    // 兼容性提示：若视频为 HEVC/AV1，Chrome <video> 可能无法播放但文件有效
    try {
      const codecs = detectCodecFromMP4(videoBuffer);
      const hasHEVC = codecs.some(c => /hev1|hvc1/i.test(c));
      const hasAV1 = codecs.some(c => /av01/i.test(c));
      if (hasHEVC || hasAV1) {
        report(92, '提示：视频为 ' + (hasHEVC ? 'HEVC' : 'AV1') + '，已无损合并，Chrome 或无法播放但文件有效');
      }
    } catch (e) {}

    // 5) 返回 blob（保存统一由任务执行器完成）
    report(95, '合并完成...');

    const blob = new Blob([out], { type: 'video/mp4' });
    return { blob, ext: 'mp4' };
  }

  // ==================== 视频+音频合并（MediaRecorder 实时录制兜底） ====================

  function pickRecorderMime() {
    const candidates = [
      { mimeType: 'video/mp4;codecs=avc1,mp4a', ext: 'mp4' },
      { mimeType: 'video/webm;codecs=vp9,opus', ext: 'webm' },
      { mimeType: 'video/webm;codecs=vp8,opus', ext: 'webm' },
      { mimeType: 'video/webm', ext: 'webm' },
    ];
    for (const c of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
      } catch (e) {}
    }
    return { mimeType: '', ext: 'webm' };
  }

  function mergeVideoAudio(videoBuffer, audioBuffer, ctx, report, signal) {
    return new Promise((resolve, reject) => {
      // 创建独立的 video 和 audio 元素（不复用 hidden-video，避免 createMediaElementSource 冲突）
      const videoEl = document.createElement('video');
      const audioEl = document.createElement('audio');
      videoEl.muted = true;     // 视频流不含音频，静音即可
      videoEl.playsInline = true;

      // 在 offscreen 创建 blob URL（offscreen 是完整 DOM 环境，URL.createObjectURL 可用）
      const videoBlobUrl = URL.createObjectURL(new Blob([videoBuffer], { type: 'video/mp4' }));
      const audioBlobUrl = URL.createObjectURL(new Blob([audioBuffer], { type: 'audio/mp4' }));

      let audioCtx = null;
      let audioSource = null;
      let audioDest = null;
      let recorder = null;
      let canvas = null;
      let rafId = null;
      const chunks = [];
      let started = false;
      let progressTimer = null;
      let aborted = false;

      const cleanup = () => {
        if (rafId) cancelAnimationFrame(rafId);
        if (progressTimer) clearInterval(progressTimer);
        try { if (audioSource) audioSource.disconnect(); } catch (e) {}
        try { if (audioDest) audioDest.disconnect(); } catch (e) {}
        try { if (audioCtx) audioCtx.close(); } catch (e) {}
        videoEl.src = '';
        audioEl.src = '';
        try { URL.revokeObjectURL(videoBlobUrl); } catch (e) {}
        try { URL.revokeObjectURL(audioBlobUrl); } catch (e) {}
      };

      const onLoadedMetadata = () => {
        if (started) return;
        started = true;

        try {
          // ---- 获取视频轨道 ----
          // 优先使用 video.captureStream()，不可用或无轨道时回退到 canvas
          let videoTrack = null;
          if (videoEl.captureStream) {
            try {
              const vs = videoEl.captureStream();
              videoTrack = vs.getVideoTracks()[0] || null;
            } catch (e) {}
          }
          if (!videoTrack) {
            // canvas 回退方案
            canvas = document.createElement('canvas');
            canvas.width = videoEl.videoWidth || 1280;
            canvas.height = videoEl.videoHeight || 720;
            const ctx = canvas.getContext('2d');
            const draw = () => {
              try { ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height); } catch (e) {}
              rafId = requestAnimationFrame(draw);
            };
            draw();
            const cs = canvas.captureStream(60);
            videoTrack = cs.getVideoTracks()[0];
          }

          // ---- 获取音频轨道 ----
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          audioSource = audioCtx.createMediaElementSource(audioEl);
          audioDest = audioCtx.createMediaStreamDestination();
          audioSource.connect(audioDest);

          // ---- 合并流 ----
          const combined = new MediaStream();
          combined.addTrack(videoTrack);
          audioDest.stream.getAudioTracks().forEach(t => combined.addTrack(t));

          // ---- 选择编码器 ----
          const mime = pickRecorderMime();
          const recorderOpts = { videoBitsPerSecond: 12_000_000, audioBitsPerSecond: 192_000 };
          if (mime.mimeType) recorderOpts.mimeType = mime.mimeType;

          recorder = new MediaRecorder(combined, recorderOpts);
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
          };
          recorder.onstop = () => {
            if (aborted) return; // 已被用户取消，结果丢弃
            const mergedBlob = new Blob(chunks, { type: mime.mimeType || 'video/webm' });
            cleanup();
            report(97, '合并完成，正在保存...');
            resolve({ blob: mergedBlob, ext: mime.ext });
          };
          recorder.onerror = (e) => {
            cleanup();
            reject(new Error('录制失败: ' + (e.error?.message || 'unknown')));
          };

          recorder.start(1000);

          // ---- 播放 ----
          videoEl.play().catch((e) => {
            cleanup();
            reject(new Error('视频播放失败: ' + e.message));
          });
          audioEl.play().catch(() => {
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
          });

          // ---- 进度报告 ----
          const dur = videoEl.duration || 0;
          progressTimer = setInterval(() => {
            if (videoEl.ended) {
              clearInterval(progressTimer);
              progressTimer = null;
              if (recorder.state !== 'inactive') recorder.stop();
              return;
            }
            const pct = dur > 0 ? 50 + (videoEl.currentTime / dur) * 45 : 50;
            const displayPct = dur > 0 ? Math.round((videoEl.currentTime / dur) * 100) : 0;
            report(pct, `正在合并视频+音频... ${displayPct}%`);
          }, 500);

        } catch (e) {
          cleanup();
          reject(new Error('合并初始化失败: ' + e.message));
        }
      };

      const onError = () => {
        // 出错时自动检测 codec / 浏览器支持 / video.error，生成可提交的 Bug 报告
        const err = buildDecodeError(videoBuffer, videoEl, 'merge-video-audio', ctx || {});
        cleanup();
        reject(err);
      };

      videoEl.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
      videoEl.addEventListener('error', onError, { once: true });

      // 用户确认取消：停止录制并清理
      if (signal) {
        signal.addEventListener('abort', () => {
          aborted = true;
          try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) {}
          cleanup();
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
      }

      // 超时保护（30 分钟）
      setTimeout(() => {
        if (!started) {
          cleanup();
          reject(new Error('超时：无法加载视频'));
        }
      }, 30 * 60 * 1000);

      videoEl.src = videoBlobUrl;
      audioEl.src = audioBlobUrl;
    });
  }

  // ==================== 后台下载任务管理器 ====================
  // 下载任务常驻 offscreen 文档执行：
  // - popup 关闭（误触点击页面其他地方）不影响任务，重新打开可恢复进度显示
  // - Service Worker 被闲置回收也不影响（下载引擎不依赖 SW 存活）
  // - 只有用户在 popup 中确认取消（CANCEL_DOWNLOAD）才会中止

  const downloadTasks = new Map(); // taskId → task
  const TASK_TTL_MS = 30 * 60 * 1000;        // 已结束任务保留 30 分钟供回看
  const OFFSCREEN_IDLE_MS = 10 * 60 * 1000;  // 无任务 10 分钟后自动关闭离屏文档
  let lastActivityAt = Date.now();

  function serializeTask(task) {
    return {
      taskId: task.id,
      mode: task.mode,          // 'video' | 'audio' | 'merge'
      kind: task.kind,          // 'hls' | 'm4s' | 'direct' | 'audio' | 'merge'
      mediaId: task.mediaId,
      title: task.title,
      filename: task.filename,
      status: task.status,      // 'running' | 'done' | 'error' | 'cancelled'
      progress: Math.round(task.progress),
      message: task.message,
      error: task.error || null,
      diagnostics: task.diagnostics || null,
      startedAt: task.startedAt,
      endedAt: task.endedAt || null,
    };
  }

  // 节流广播：每 250ms 最多一条（popup 与 background 均可收到）
  const broadcastTimers = new Map();
  function broadcastTask(task, force) {
    const now = Date.now();
    if (!force && now - (broadcastTimers.get(task.id) || 0) < 250) return;
    broadcastTimers.set(task.id, now);
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PROGRESS',
      ...serializeTask(task),
    }).catch(() => {});
  }

  function abortError() {
    return new DOMException('The operation was aborted.', 'AbortError');
  }

  function startTask(spec) {
    if (!spec || !spec.id) throw new Error('任务参数无效');
    if (downloadTasks.has(spec.id)) return spec.id;
    const task = {
      ...spec,
      status: 'running',
      progress: 0,
      message: '排队中...',
      error: null,
      diagnostics: null,
      startedAt: Date.now(),
      endedAt: null,
      abort: new AbortController(),
    };
    downloadTasks.set(task.id, task);
    lastActivityAt = Date.now();
    broadcastTask(task, true);

    runTask(task); // 异步执行，不阻塞 ack
    return task.id;
  }

  function cancelTask(taskId) {
    const task = downloadTasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.abort.abort();
    return true; // 状态由 runTask 的 catch 收尾并广播
  }

  async function runTask(task) {
    const onProgress = (progress, message) => {
      task.progress = progress;
      task.message = message;
      lastActivityAt = Date.now();
      broadcastTask(task);
    };
    try {
      if (task.kind === 'hls') await runHlsTask(task, onProgress);
      else if (task.kind === 'm4s') await runM4sTask(task, onProgress);
      else if (task.kind === 'direct') await runDirectTask(task, onProgress);
      else if (task.kind === 'audio') await runAudioTask(task, onProgress);
      else if (task.kind === 'merge') await runMergeTask(task, onProgress);
      else throw new Error(`未知任务类型: ${task.kind}`);

      if (task.abort.signal.aborted) throw abortError();
      task.status = 'done';
      task.progress = 100;
      task.message = '下载完成 ✅';
    } catch (e) {
      if (task.abort.signal.aborted || e.name === 'AbortError') {
        task.status = 'cancelled';
        task.message = '已取消（用户确认）';
      } else {
        task.status = 'error';
        task.error = e.message;
        task.diagnostics = e.diagnostics || null;
        task.message = '错误: ' + e.message;
        console.error('[VC-Offscreen] 后台下载失败:', task.kind, e);
      }
    } finally {
      task.endedAt = Date.now();
      broadcastTimers.delete(task.id);
      broadcastTask(task, true);
    }
  }

  // 已结束任务到期清理；长期无任务自动关闭离屏文档节省内存
  setInterval(async () => {
    const now = Date.now();
    for (const [id, t] of downloadTasks) {
      if (t.status !== 'running' && t.endedAt && now - t.endedAt > TASK_TTL_MS) {
        downloadTasks.delete(id);
      }
    }
    const hasRunning = [...downloadTasks.values()].some(t => t.status === 'running');
    if (!hasRunning && now - lastActivityAt > OFFSCREEN_IDLE_MS) {
      // 无任务闲置：优先自己关，失败则请 Service Worker 代关
      let closed = false;
      try { await chrome.offscreen.closeDocument(); closed = true; } catch (e) {}
      if (!closed) {
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_IDLE_CLOSE' }).catch(() => {});
      }
    }
  }, 60 * 1000);

  // ---------- 下载工具（自 background.js 迁移，增加 signal 取消） ----------

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

  const mb = (n) => Math.round(n / 1024 / 1024) + 'MB';

  // 流式 fetch → ArrayBuffer，带取消与进度
  async function fetchBuffer(url, { signal, onProgress } = {}) {
    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const contentLength = parseInt(resp.headers.get('content-length') || '0');
    if (!resp.body || !contentLength) return resp.arrayBuffer();
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) onProgress(received, contentLength);
    }
    return concatArrayBuffers(chunks.map(c => c.buffer));
  }

  // 生成 (received, total) → onProgress 的适配器；无总长时进度停在区间末端仅更新文案
  function makeStreamProgress(onProgress, base, span) {
    return (recv, total) => {
      if (total > 0) onProgress(base + (recv / total) * span, `下载中 ${mb(recv)} / ${mb(total)}`);
      else onProgress(base + span, `下载中 ${mb(recv)}`);
    };
  }

  // blob → 委托 SW 执行 chrome.downloads
  // （offscreen 文档有 DOM 可创建 blob URL，但没有 chrome.downloads API；
  //   blob URL 在扩展 origin 内全局有效，SW 调 chrome.downloads.download 可读取该 blob）
  async function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      const resp = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'SAVE_BLOB_DOWNLOAD',
        url, filename,
      });
      if (!resp || resp.error) throw new Error((resp && resp.error) || 'SW 下载失败');
    } catch (e) {
      try { URL.revokeObjectURL(url); } catch (e2) {}
      throw new Error('下载失败: ' + (e.message || e));
    }
    // 延迟释放，给下载管理器读取时间（大文件覆盖 5 分钟）
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 5 * 60 * 1000);
  }

  // ---------- 任务执行器 ----------

  // HLS：解析 m3u8 → 下载分段 → 拼接保存
  async function runHlsTask(task, onProgress) {
    const signal = task.abort.signal;
    onProgress(0, '正在解析播放列表...');
    const resp = await fetch(task.url, { signal });
    const parsed = parseM3U8(await resp.text(), task.url);

    if (parsed.keyInfo && parsed.keyInfo.method !== 'NONE') throw new Error('加密的 HLS 流暂不支持');

    let segmentUrls = [];
    let initSegment = null;

    if (parsed.isMaster) {
      const sorted = parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
      const selected = sorted[task.qualityIndex || 0] || sorted[0];
      onProgress(5, `已选择: ${selected.resolution || '默认'}`);
      const resp2 = await fetch(selected.url, { signal });
      const parsed2 = parseM3U8(await resp2.text(), selected.url);
      segmentUrls = parsed2.segments;
      initSegment = parsed2.initSegmentUrl;
      if (parsed2.keyInfo && parsed2.keyInfo.method !== 'NONE') throw new Error('加密的 HLS 流暂不支持');
    } else {
      segmentUrls = parsed.segments;
      initSegment = parsed.initSegmentUrl;
    }

    if (!segmentUrls.length) throw new Error('未找到任何分段');

    const buffers = [];
    const total = segmentUrls.length + (initSegment ? 1 : 0);
    if (initSegment) {
      onProgress(2, '下载初始化分段...');
      const r = await fetch(initSegment, { signal });
      buffers.push(await r.arrayBuffer());
    }
    for (let i = 0; i < segmentUrls.length; i++) {
      const segResp = await fetch(segmentUrls[i], { signal });
      buffers.push(await segResp.arrayBuffer());
      onProgress(((i + 1 + (initSegment ? 1 : 0)) / total) * 95, `下载分段 ${i + 1}/${segmentUrls.length}`);
    }

    onProgress(97, '正在合并分段...');
    const merged = concatArrayBuffers(buffers);
    const isFMP4 = initSegment !== null;
    const ext = isFMP4 ? 'mp4' : 'ts';
    const mimeType = isFMP4 ? 'video/mp4' : 'video/mp2t';
    const finalName = task.filename.endsWith(`.${ext}`) ? task.filename : task.filename.replace(/\.[^.]+$/, '') + `.${ext}`;
    await saveBlob(new Blob([merged], { type: mimeType }), finalName);
  }

  // B站 m4s 流（含备用线路）
  async function runM4sTask(task, onProgress) {
    const signal = task.abort.signal;
    onProgress(0, '正在下载...');
    let buffer;
    try {
      buffer = await fetchBuffer(task.url, { signal, onProgress: makeStreamProgress(onProgress, 0, 95) });
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') throw e;
      if (!task.backupUrl) throw e;
      onProgress(0, '使用备用线路下载...');
      buffer = await fetchBuffer(task.backupUrl, { signal, onProgress: makeStreamProgress(onProgress, 0, 95) });
    }
    onProgress(97, '正在处理...');
    await saveBlob(new Blob([buffer], { type: 'video/mp4' }), task.filename);
  }

  // 直接 URL 视频
  async function runDirectTask(task, onProgress) {
    const signal = task.abort.signal;
    onProgress(0, '正在下载...');
    const buffer = await fetchBuffer(task.url, { signal, onProgress: makeStreamProgress(onProgress, 0, 95) });

    onProgress(97, '正在处理...');
    let mimeType = 'application/octet-stream';
    const ext = (task.filename.match(/\.[^.]+$/) || ['.mp4'])[0].slice(1).toLowerCase();
    if (task.mediaType === 'video') mimeType = ext === 'flv' ? 'video/x-flv' : 'video/mp4';
    else if (task.mediaType === 'audio') mimeType = `audio/${ext}`;
    await saveBlob(new Blob([buffer], { type: mimeType }), task.filename);
  }

  // 音频：dash-audio 直存/转码；hls/视频源先下载再提取
  async function runAudioTask(task, onProgress) {
    const signal = task.abort.signal;
    const { sourceType, format, bitrate, codecs } = task;
    const ctx = task.ctx || {};
    let arrayBuffer;

    if (sourceType === 'dash-audio') {
      onProgress(0, '下载音频流...');
      try {
        arrayBuffer = await fetchBuffer(task.url, { signal, onProgress: makeStreamProgress(onProgress, 0, 45) });
      } catch (e) {
        if (signal.aborted || e.name === 'AbortError') throw e;
        if (!task.backupUrl) throw e;
        onProgress(0, '使用备用线路下载音频...');
        arrayBuffer = await fetchBuffer(task.backupUrl, { signal, onProgress: makeStreamProgress(onProgress, 0, 45) });
      }

      // FLAC 源直接保存，无需转码
      if ((codecs || '').includes('fLaC')) {
        onProgress(95, '保存 FLAC...');
        await saveBlob(new Blob([arrayBuffer], { type: 'audio/flac' }), task.filename);
        return;
      }
    } else if (sourceType === 'hls') {
      onProgress(0, '下载 HLS 分段...');
      const resp = await fetch(task.url, { signal });
      const parsed = parseM3U8(await resp.text(), task.url);
      let segmentUrls = [];
      if (parsed.isMaster) {
        const sorted = parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth);
        const selected = sorted[task.qualityIndex || 0] || sorted[0];
        const resp2 = await fetch(selected.url, { signal });
        segmentUrls = parseM3U8(await resp2.text(), selected.url).segments;
      } else {
        segmentUrls = parsed.segments;
      }
      const buffers = [];
      for (let i = 0; i < segmentUrls.length; i++) {
        const r = await fetch(segmentUrls[i], { signal });
        buffers.push(await r.arrayBuffer());
        onProgress(((i + 1) / segmentUrls.length) * 45, `下载分段 ${i + 1}/${segmentUrls.length}`);
      }
      arrayBuffer = concatArrayBuffers(buffers);
    } else {
      onProgress(0, '下载视频流...');
      arrayBuffer = await fetchBuffer(task.url, { signal, onProgress: makeStreamProgress(onProgress, 0, 45) });
    }

    onProgress(50, '正在提取并编码音频...');
    const blob = await extractAudioToBlob(arrayBuffer, format, bitrate, ctx,
      (p, m) => onProgress(50 + (p / 100) * 45, m), signal);
    await saveBlob(blob, task.filename);
  }

  // 音频提取 + 编码（原 EXTRACT_AUDIO 消息核心，改为函数供任务调用）
  async function extractAudioToBlob(arrayBuffer, format, bitrate, ctx, onProgress, signal) {
    if (!arrayBuffer || arrayBuffer.byteLength === 0) throw new Error('无音频数据');

    onProgress(10, '正在解码音频...');
    let audioBuffer = await tryFastDecode(arrayBuffer);

    if (!audioBuffer) {
      onProgress(20, '正在实时提取音频（可能需要一些时间）...');
      audioBuffer = await captureAudioFromVideo(arrayBuffer, undefined, ctx, signal);
    }

    onProgress(70, `正在编码为 ${(format || 'mp3').toUpperCase()}...`);
    let blob;
    if (format === 'wav' || format === 'flac') {
      // FLAC 编码需要额外库，暂用 WAV 作为无损替代
      blob = encodeWAV(audioBuffer);
    } else {
      blob = encodeMP3(audioBuffer, bitrate || 320);
    }

    onProgress(95, '编码完成，准备下载...');
    return blob;
  }

  // 视频+音频合并：下载两路流 → 快速 remux（失败回退 MediaRecorder 实时录制）
  async function runMergeTask(task, onProgress) {
    const signal = task.abort.signal;

    // 1. 下载视频流
    onProgress(2, '下载视频流...');
    let videoBuffer;
    try {
      videoBuffer = await fetchBuffer(task.video.url, { signal, onProgress: makeStreamProgress(onProgress, 2, 30) });
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') throw e;
      if (!task.video.backupUrl) throw e;
      onProgress(2, '视频流使用备用线路...');
      videoBuffer = await fetchBuffer(task.video.backupUrl, { signal, onProgress: makeStreamProgress(onProgress, 2, 30) });
    }

    // 2. 下载音频流
    onProgress(35, '下载音频流...');
    let audioBuffer;
    try {
      audioBuffer = await fetchBuffer(task.audio.url, { signal, onProgress: makeStreamProgress(onProgress, 35, 10) });
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') throw e;
      if (!task.audio.backupUrl) throw e;
      onProgress(35, '音频流使用备用线路...');
      audioBuffer = await fetchBuffer(task.audio.backupUrl, { signal, onProgress: makeStreamProgress(onProgress, 35, 10) });
    }

    // 3. 合并（进度刻度沿用 48-97）
    onProgress(48, '正在初始化合并...');
    const ctx = {
      ...(task.ctx || {}),
      videoUrl: task.video.url,
      audioUrl: task.audio.url,
      videoSize: videoBuffer.byteLength,
      audioSize: audioBuffer.byteLength,
    };

    let result;
    try {
      onProgress(52, '快速合并：解析 fragmented MP4（无重编码）...');
      result = await fastRemuxMP4(videoBuffer, audioBuffer, ctx, onProgress);
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') throw e;
      console.log('[VC-Offscreen] 快速合并不可用，回退实时录制:', e.message);
      onProgress(50, '快速模式不可用，切换实时录制...');
      result = await mergeVideoAudio(videoBuffer, audioBuffer, ctx, onProgress, signal);
    }

    onProgress(99, '正在保存...');
    await saveBlob(result.blob, `${task.filename}.${result.ext}`);
  }

  // ==================== 消息处理 ====================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return;

    // ----- 后台下载任务（常驻 offscreen 执行，popup 关闭不影响） -----
    if (message.type === 'START_DOWNLOAD') {
      try {
        const taskId = startTask(message.task || {});
        sendResponse({ ok: true, taskId });
      } catch (e) {
        sendResponse({ error: e.message });
      }
      return true;
    }

    // 只有用户在 popup 中明确确认后才会发来这条消息
    if (message.type === 'CANCEL_DOWNLOAD') {
      const ok = cancelTask(message.taskId);
      sendResponse({ ok });
      return true;
    }

    if (message.type === 'GET_DOWNLOAD_STATUS') {
      sendResponse({ tasks: [...downloadTasks.values()].map(serializeTask) });
      return true;
    }

    if (message.type === 'DISMISS_TASK') {
      const t = downloadTasks.get(message.taskId);
      if (t && t.status !== 'running') downloadTasks.delete(message.taskId);
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'PING_OFFSCREEN') {
      sendResponse({ alive: true });
      return true;
    }
  });

  // 通知 background 离屏文档已就绪
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

  console.log('[VC-Offscreen] 离屏文档已加载');
})();
