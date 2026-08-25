/**
 * offscreen/offscreen.js
 * 离屏文档：音频提取与编码
 * 1. 尝试 decodeAudioData 快速解码（非实时）
 * 2. 失败时使用 video 元素 + AudioContext 实时提取
 * 3. 编码为 MP3 (lamejs) 或 WAV (原生)
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

  function captureAudioFromVideo(arrayBuffer, mimeType, ctx) {
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

  async function fastRemuxMP4(videoBuffer, audioBuffer, filename, ctx) {
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

    chrome.runtime.sendMessage({
      type: 'AUDIO_PROGRESS', progress: 60, message: '正在合并音视频轨道（无重编码）...',
    }).catch(() => {});

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

    chrome.runtime.sendMessage({
      type: 'AUDIO_PROGRESS', progress: 80, message: '正在写入媒体分片...',
    }).catch(() => {});

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
        chrome.runtime.sendMessage({
          type: 'AUDIO_PROGRESS', progress: 92,
          message: '提示：视频为 ' + (hasHEVC ? 'HEVC' : 'AV1') + '，已无损合并，Chrome 或无法播放但文件有效',
        }).catch(() => {});
      }
    } catch (e) {}

    // 5) 下载
    chrome.runtime.sendMessage({
      type: 'AUDIO_PROGRESS', progress: 95, message: '合并完成，正在保存...',
    }).catch(() => {});

    const blob = new Blob([out], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url, filename: `${filename}.mp4`, saveAs: false });
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
    } catch (e) {
      try { URL.revokeObjectURL(url); } catch (e2) {}
      throw new Error('下载失败: ' + e.message);
    }
    return { success: true, ext: 'mp4' };
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

  function mergeVideoAudio(videoBuffer, audioBuffer, filename, mergeId, tabId, ctx) {
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
          recorder.onstop = async () => {
            const mergedBlob = new Blob(chunks, { type: mime.mimeType || 'video/webm' });
            const mergedUrl = URL.createObjectURL(mergedBlob);
            // 清理 video/audio 元素和输入 blob URL（mergedUrl 单独保留给下载用）
            cleanup();
            chrome.runtime.sendMessage({
              type: 'AUDIO_PROGRESS',
              progress: 97,
              message: '合并完成，正在保存...',
            }).catch(() => {});
            // 直接在 offscreen 下载（offscreen 是完整 DOM，blob URL 可用；
            // background Service Worker 没有 URL.createObjectURL，无法处理 blob 下载）
            try {
              await chrome.downloads.download({
                url: mergedUrl,
                filename: `${filename}.${mime.ext}`,
                saveAs: false,
              });
              // 延迟释放，给下载管理器读取时间
              setTimeout(() => { try { URL.revokeObjectURL(mergedUrl); } catch (e) {} }, 60000);
              resolve({ success: true, ext: mime.ext });
            } catch (e) {
              try { URL.revokeObjectURL(mergedUrl); } catch (e2) {}
              reject(new Error('下载失败: ' + e.message));
            }
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
            chrome.runtime.sendMessage({
              type: 'AUDIO_PROGRESS',
              progress: pct,
              message: `正在合并视频+音频... ${displayPct}%`,
            }).catch(() => {});
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

  // ==================== 消息处理 ====================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return;

    if (message.type === 'MERGE_VIDEO_AUDIO') {
      (async () => {
        try {
          const { videoBuffer, audioBuffer, filename, mergeId, tabId, ctx } = message;
          chrome.runtime.sendMessage({
            type: 'AUDIO_PROGRESS',
            progress: 48,
            message: '正在初始化合并...',
          }).catch(() => {});

          // 优先走快速无重编码 remux（fMP4 → 秒级合并）；
          // 失败（非 fMP4 / 结构异常）回退到 MediaRecorder 实时录制
          let result;
          try {
            chrome.runtime.sendMessage({
              type: 'AUDIO_PROGRESS',
              progress: 52,
              message: '快速合并：解析 fragmented MP4（无重编码）...',
            }).catch(() => {});
            result = await fastRemuxMP4(videoBuffer, audioBuffer, filename, ctx);
          } catch (e) {
            console.log('[VC-Offscreen] 快速合并不可用，回退实时录制:', e.message);
            chrome.runtime.sendMessage({
              type: 'AUDIO_PROGRESS',
              progress: 50,
              message: '快速模式不可用，切换实时录制...',
            }).catch(() => {});
            result = await mergeVideoAudio(videoBuffer, audioBuffer, filename, mergeId, tabId, ctx);
          }

          sendResponse({ success: true, ext: result.ext });
        } catch (e) {
          console.error('[VC-Offscreen] 合并失败:', e);
          // 透出 diagnostics 供 popup 渲染 Bug 报告
          sendResponse({
            error: e.message,
            diagnostics: e.diagnostics || null,
          });
        }
      })();
      return true;
    }

    // background Service Worker 没有 URL.createObjectURL，所有 Blob 下载都委托给 offscreen
    if (message.type === 'DOWNLOAD_BLOB') {
      (async () => {
        try {
          const { arrayBuffer, filename, mimeType } = message;
          if (!arrayBuffer || arrayBuffer.byteLength === 0) {
            sendResponse({ error: '无数据' });
            return;
          }
          const blob = new Blob([arrayBuffer], { type: mimeType || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          await chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: false,
          });
          setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
          sendResponse({ success: true });
        } catch (e) {
          console.error('[VC-Offscreen] 下载失败:', e);
          sendResponse({ error: e.message });
        }
      })();
      return true;
    }

    if (message.type === 'EXTRACT_AUDIO') {
      (async () => {
        try {
          const { arrayBuffer, format, bitrate, ctx } = message;

          if (!arrayBuffer || arrayBuffer.byteLength === 0) {
            sendResponse({ error: '无音频数据' });
            return;
          }

          // 报告进度
          chrome.runtime.sendMessage({
            type: 'AUDIO_PROGRESS',
            progress: 10,
            message: '正在解码音频...',
          }).catch(() => {});

          // 尝试快速解码
          let audioBuffer = await tryFastDecode(arrayBuffer);

          if (!audioBuffer) {
            // 快速解码失败，使用 video 元素实时提取
            chrome.runtime.sendMessage({
              type: 'AUDIO_PROGRESS',
              progress: 20,
              message: '正在实时提取音频（可能需要一些时间）...',
            }).catch(() => {});

            audioBuffer = await captureAudioFromVideo(arrayBuffer, undefined, ctx);
          }

          // 编码
          chrome.runtime.sendMessage({
            type: 'AUDIO_PROGRESS',
            progress: 70,
            message: `正在编码为 ${format.toUpperCase()}...`,
          }).catch(() => {});

          let blob;
          if (format === 'wav') {
            blob = encodeWAV(audioBuffer);
          } else if (format === 'flac') {
            // FLAC 编码需要额外库，暂用 WAV 作为无损替代
            blob = encodeWAV(audioBuffer);
          } else {
            // 默认 MP3
            blob = encodeMP3(audioBuffer, bitrate || 320);
          }

          chrome.runtime.sendMessage({
            type: 'AUDIO_PROGRESS',
            progress: 95,
            message: '编码完成，准备下载...',
          }).catch(() => {});

          sendResponse({ blob: blob });
        } catch (e) {
          console.error('[VC-Offscreen] 音频处理失败:', e);
          sendResponse({
            error: e.message,
            diagnostics: e.diagnostics || null,
          });
        }
      })();
      return true; // 保持通道
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
