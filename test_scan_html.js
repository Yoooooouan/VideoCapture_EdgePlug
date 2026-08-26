/**
 * 快速验证 extractVideosFromHtml 的解析逻辑（与 background.js 中实现保持一致）
 * 运行：node test_scan_html.js
 */

const MEDIA_EXT_RE = /\.(m3u8|mp4|m4s|flv|ts|m4a|aac|mp3|wav|flac|webm|ogg)(\?|#|$)/i;

function resolveUrl(url, baseUrl) {
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function extractVideosFromHtml(html, baseUrl) {
  const found = new Map();

  const addUrl = (rawUrl) => {
    if (!rawUrl) return;
    const url = resolveUrl(rawUrl.trim().replace(/&amp;/g, '&'), baseUrl);
    if (!/^https?:/i.test(url)) return;
    const extM = url.match(MEDIA_EXT_RE);
    if (!extM) return;
    const ext = extM[1].toLowerCase();
    if (ext === 'ts') return;
    let type = 'video';
    if (ext === 'm3u8') type = 'hls';
    else if (['m4a', 'aac', 'mp3', 'wav', 'flac', 'ogg'].includes(ext)) type = 'audio';
    else if (ext === 'm4s') type = 'dash';
    if (!found.has(url)) found.set(url, { url, ext, type });
  };

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

  const rawUrlRe = /(?:https?:)?\/\/[^\s"'<>()\\]+?\.(?:m3u8|mp4|webm|flv|m4s)(?:\?[^\s"'<>()\\]*)?/gi;
  let m;
  while ((m = rawUrlRe.exec(html)) !== null) addUrl(m[0]);

  return [...found.values()];
}

// ===== 测试用例 =====
const BASE = 'https://example.com/watch/1';
let pass = 0, fail = 0;

function check(name, html, expect) {
  const results = extractVideosFromHtml(html, BASE);
  const urls = results.map(r => r.url).sort();
  const expected = [...expect].sort();
  const ok = JSON.stringify(urls) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`    期望: ${JSON.stringify(expected)}`);
    console.log(`    实际: ${JSON.stringify(urls)}`);
  }
  return results;
}

console.log('--- extractVideosFromHtml 测试 ---');

// 1. video 标签 src
check('video src 绝对地址',
  `<video src="https://cdn.example.com/v/abc.mp4" controls></video>`,
  ['https://cdn.example.com/v/abc.mp4']);

// 2. video data-src 懒加载
check('video data-src 懒加载',
  `<video data-src="/media/xyz.mp4" class="lazy"></video>`,
  ['https://example.com/media/xyz.mp4']);

// 3. source 子元素（多清晰度）
check('source 标签相对路径',
  `<video><source src="https://cdn.example.com/hls/master.m3u8" type="application/x-mpegURL"></video>`,
  ['https://cdn.example.com/hls/master.m3u8']);

// 4. og:video meta（property 在前）
check('og:video meta property 在前',
  `<meta property="og:video" content="https://cdn.example.com/embed/999.mp4">`,
  ['https://cdn.example.com/embed/999.mp4']);

// 5. og:video:secure_url（content 在前）
check('og:video content 在前',
  `<meta content="https://cdn.example.com/embed/777.mp4" property="og:video:secure_url">`,
  ['https://cdn.example.com/embed/777.mp4']);

// 6. JS 变量内嵌地址 + 协议相对
const r6 = check('JS 内嵌裸 URL 与 // 协议相对',
  `<script>var player = { url: "https://vod.example.com/dash/vid.m4s?token=abc" };</script>
   <script>var backup = "//mirror.example.com/video/bk.mp4";</script>`,
  ['https://vod.example.com/dash/vid.m4s?token=abc', 'https://mirror.example.com/video/bk.mp4']);
console.log(`    类型判定: ${r6.map(r => `${r.ext}=${r.type}`).join(', ')}`);

// 7. 去重（同一 URL 出现多次）
check('同一 URL 去重',
  `<video src="https://cdn.example.com/v/abc.mp4"></video>
   <a href="https://cdn.example.com/v/abc.mp4">dl</a>`,
  ['https://cdn.example.com/v/abc.mp4']);

// 8. HTML 实体转义 &amp;
check('&amp; 实体解码',
  `<video src="https://cdn.example.com/v/a.mp4?sign=1&amp;exp=2"></video>`,
  ['https://cdn.example.com/v/a.mp4?sign=1&exp=2']);

// 9. ts 分段过滤（只应有 m3u8）
check('ts 分段被过滤',
  `<script>var segs = ["https://cdn.example.com/hls/seg0.ts","https://cdn.example.com/hls/master.m3u8"];</script>`,
  ['https://cdn.example.com/hls/master.m3u8']);

// 10. 音频扩展名类型
const r10 = check('音频类型判定',
  `<audio src="https://cdn.example.com/a/podcast.m4a"></audio>`,
  ['https://cdn.example.com/a/podcast.m4a']);
console.log(`    m4a 类型: ${r10[0].type}（期望 audio）`);

// 11. blob: 与非 http 被忽略
check('blob 与 data URI 被忽略',
  `<video src="blob:https://example.com/abc"></video>`,
  []);

// 12. URL 中含查询串的 m3u8（裸 URL 正则）
check('带查询串的裸 m3u8',
  `<script>src:"https://p.example.com/live/stream.m3u8?auth=xyz123"</script>`,
  ['https://p.example.com/live/stream.m3u8?auth=xyz123']);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
