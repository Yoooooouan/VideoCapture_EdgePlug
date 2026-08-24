/**
 * offscreen/offscreen.js
 * 离屏文档：音频提取与编码
 * 1. 尝试 decodeAudioData 快速解码（非实时）
 * 2. 失败时使用 video 元素 + AudioContext 实时提取
 * 3. 编码为 MP3 (lamejs) 或 WAV (原生)
 */

(function () {
  'use strict';

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

  function captureAudioFromVideo(arrayBuffer, mimeType) {
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
        cleanup();
        reject(new Error('视频解码失败（格式不支持）'));
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

  // ==================== 消息处理 ====================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return;

    if (message.type === 'EXTRACT_AUDIO') {
      (async () => {
        try {
          const { arrayBuffer, format, bitrate } = message;

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

            audioBuffer = await captureAudioFromVideo(arrayBuffer);
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
          sendResponse({ error: e.message });
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
