import fs from 'fs';
import os from 'os';
import http from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { PDFDocument } from 'pdf-lib';
import { isEncrypted, decryptPDF } from '@pdfsmaller/pdf-decrypt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '80mb' }));
app.use(express.urlencoded({ extended: true, limit: '80mb' }));

const LOCAL_ASSET_CANDIDATES = [
  path.join(os.homedir(), 'storage', 'shared', 'Download', 'HakoniwaData'),
  path.join(os.homedir(), 'storage', 'shared', 'HakoniwaData'),
  '/sdcard/Download/HakoniwaData',
  '/sdcard/HakoniwaData',
  path.join(__dirname, 'HakoniwaData')
];
function ensureNoMediaInDirSync(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const nm = path.join(dirPath, '.nomedia');
    if (!fs.existsSync(nm)) {
      fs.writeFileSync(nm, '');
    }
  } catch (_) {}
}

let LOCAL_ASSETS_ROOT = LOCAL_ASSET_CANDIDATES[LOCAL_ASSET_CANDIDATES.length - 1];
for (const cand of LOCAL_ASSET_CANDIDATES) {
  try {
    fs.mkdirSync(cand, { recursive: true });
    const testFile = path.join(cand, '.wt');
    fs.writeFileSync(testFile, '1');
    fs.unlinkSync(testFile);
    ensureNoMediaInDirSync(cand);
    LOCAL_ASSETS_ROOT = cand;
    break;
  } catch (_) {}
}

app.use('/local-assets', express.static(LOCAL_ASSETS_ROOT, {
  maxAge: 0,
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('/api/local-assets/ping', (_req, res) => {
  ensureNoMediaInDirSync(LOCAL_ASSETS_ROOT);
  res.json({
    ok: true,
    service: 'hakoniwa-local-bridge',
    mode: 'server',
    root: LOCAL_ASSETS_ROOT
  });
});

app.post('/api/local-assets/save', async (req, res) => {
  try {
    const rawRel = String(req.body?.path || 'file.bin').split('?')[0].replace(/^\/+/, '').replace(/\.\./g, '_');
    const dataUrl = String(req.body?.dataUrl || '');
    if (!dataUrl && !rawRel.endsWith('.nomedia')) {
      return res.status(400).json({ ok: false, error: 'Missing dataUrl' });
    }
    const base64Part = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const fileBuf = base64Part ? Buffer.from(base64Part, 'base64') : Buffer.alloc(0);
    const targetPath = path.resolve(LOCAL_ASSETS_ROOT, rawRel);
    if (!targetPath.startsWith(path.resolve(LOCAL_ASSETS_ROOT))) {
      return res.status(400).json({ ok: false, error: 'Invalid path' });
    }
    const targetDir = path.dirname(targetPath);
    await fs.promises.mkdir(targetDir, { recursive: true });
    ensureNoMediaInDirSync(LOCAL_ASSETS_ROOT);
    ensureNoMediaInDirSync(targetDir);
    await fs.promises.writeFile(targetPath, fileBuf);
    const encodedRel = rawRel.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    res.json({
      ok: true,
      url: `/local-assets/${encodedRel}`,
      path: targetPath,
      root: LOCAL_ASSETS_ROOT
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/local-assets/cleanup', async (req, res) => {
  try {
    const activeRelList = Array.isArray(req.body?.activePaths) ? req.body.activePaths : [];
    const activeSet = new Set(
      activeRelList.map((p) => String(p || '').split('?')[0].replace(/^\/+/, '').replace(/\.\./g, '_'))
    );
    const rootAbs = path.resolve(LOCAL_ASSETS_ROOT);
    let removedCount = 0;

    const walkAndClean = async (dirPath) => {
      let entries = [];
      try {
        entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const entry of entries) {
        if (entry.name === '.wt' || entry.name === '.nomedia') continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await walkAndClean(fullPath);
          try {
            const rem = (await fs.promises.readdir(fullPath)).filter((n) => n !== '.nomedia');
            if (rem.length === 0) {
              const nmPath = path.join(fullPath, '.nomedia');
              if (fs.existsSync(nmPath)) await fs.promises.unlink(nmPath).catch(() => {});
              await fs.promises.rmdir(fullPath);
            }
          } catch (_) {}
        } else if (entry.isFile()) {
          const rel = path.relative(rootAbs, fullPath).split(path.sep).join('/');
          if (!activeSet.has(rel)) {
            try {
              await fs.promises.unlink(fullPath);
              removedCount += 1;
            } catch (_) {}
          }
        }
      }
    };

    await walkAndClean(rootAbs);
    ensureNoMediaInDirSync(rootAbs);
    res.json({ ok: true, removedCount, root: LOCAL_ASSETS_ROOT });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/merge-pdf', async (req, res) => {
  try {
    const { files = [] } = req.body;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: '没有提供需要合并的PDF文件' });
    }

    const mergedDoc = await PDFDocument.create();

    for (let fIdx = 0; fIdx < files.length; fIdx++) {
      const item = files[fIdx];
      if (!item || !item.data) continue;

      const rawBuffer = Buffer.from(item.data, 'base64');
      let bytes = new Uint8Array(rawBuffer);

      try {
        const encInfo = await isEncrypted(bytes);
        if (encInfo && encInfo.encrypted) {
          try {
            bytes = await decryptPDF(bytes, '');
          } catch (decErr) {
            console.warn('[PDF合并] 解密提示:', decErr.message);
          }
        }
      } catch (checkErr) {
        console.warn('[PDF合并] 加密检测跳过:', checkErr.message);
      }

      let donor = null;
      try {
        donor = await PDFDocument.load(bytes, {
          ignoreEncryption: true,
          throwOnInvalidObject: false,
          updateMetadata: false,
          capNumbers: true
        });
      } catch (loadErr) {
        let trimmedBytes = bytes;
        for (let b = 0; b < Math.min(bytes.length - 4, 2048); b++) {
          if (bytes[b] === 0x25 && bytes[b + 1] === 0x50 && bytes[b + 2] === 0x44 && bytes[b + 3] === 0x46 && bytes[b + 4] === 0x2D) {
            trimmedBytes = bytes.subarray(b);
            break;
          }
        }
        donor = await PDFDocument.load(trimmedBytes, {
          ignoreEncryption: true,
          throwOnInvalidObject: false,
          updateMetadata: false,
          capNumbers: true
        });
      }

      if (donor) {
        const indices = donor.getPageIndices();
        let copiedAll = false;
        try {
          const copied = await mergedDoc.copyPages(donor, indices);
          for (const page of copied) {
            mergedDoc.addPage(page);
          }
          copiedAll = true;
        } catch (batchErr) {
          console.warn('[PDF合并] 批量页面复制提示，改为逐页复制:', batchErr.message);
        }

        if (!copiedAll) {
          for (let p = 0; p < indices.length; p++) {
            const pageIndex = indices[p];
            try {
              const [singlePage] = await mergedDoc.copyPages(donor, [pageIndex]);
              mergedDoc.addPage(singlePage);
            } catch (singleErr) {
              try {
                const donorPage = donor.getPage(pageIndex);
                const [embedded] = await mergedDoc.embedPages([donorPage]);
                const newPage = mergedDoc.addPage([embedded.width, embedded.height]);
                newPage.drawPage(embedded);
              } catch (embedErr) {
                console.warn(`[PDF合并] 第 ${fIdx + 1} 个文件第 ${p + 1} 页复制异常:`, embedErr.message);
              }
            }
          }
        }
      }
    }

    if (mergedDoc.getPageCount() === 0) {
      return res.status(400).json({ error: '合并结果为空，请检查文件是否为有效PDF' });
    }

    const outputBytes = await mergedDoc.save({ useObjectStreams: false });
    const base64Out = Buffer.from(outputBytes).toString('base64');
    return res.json({ success: true, pdfBase64: base64Out, pageCount: mergedDoc.getPageCount() });
  } catch (err) {
    console.error('PDF合并错误:', err);
    return res.status(500).json({ error: err.message || 'PDF合并处理失败' });
  }
});

// Forward proxy for AI requests to prevent browser CORS and network failures
app.post('/api/proxy', async (req, res) => {
  req.setTimeout(600000);
  res.setTimeout(600000);

  try {
    const { url, method = 'POST', headers = {}, body } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'Missing target url' });
    }

    const fetchHeaders = { ...headers };
    delete fetchHeaders['host'];
    delete fetchHeaders['origin'];
    delete fetchHeaders['referer'];

    const fetchOptions = {
      method,
      headers: fetchHeaders
    };

    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = typeof body === 'object' ? JSON.stringify(body) : body;
    }

    const response = await fetch(url, fetchOptions);
    const contentType = response.headers.get('content-type') || '';
    res.status(response.status);

    if (contentType.includes('event-stream') || contentType.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } catch (streamErr) {
          console.warn('[Proxy Stream] Stream reading error:', streamErr.message);
        } finally {
          res.end();
        }
        return;
      }
    }

    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    if (contentType.includes('application/json')) {
      const data = await response.json();
      return res.json(data);
    } else if (contentType.includes('text/')) {
      const text = await response.text();
      return res.send(text);
    } else {
      const arrayBuffer = await response.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    }
  } catch (err) {
    console.error('Proxy request error:', err);
    res.status(500).json({ error: err.message || 'Proxy request failed' });
  }
});

// Music Station Search & Weighted Song+Artist Ranking API (JD/GD Music Station, NetEase, QQ Music)
function normalizeMusicStr(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_·.,，。！!？?'"“”‘’《》〈〉【】\[\]\/\\]/g, '').trim();
}

function calcMusicMatchScore(candidateTitle, candidateArtist, targetSong, targetArtist, hasDirectUrl) {
  const cTitle = normalizeMusicStr(candidateTitle);
  const cArtist = normalizeMusicStr(candidateArtist);
  const tSong = normalizeMusicStr(targetSong);
  const tArtist = normalizeMusicStr(targetArtist);
  let score = 0;

  if (tSong) {
    if (cTitle === tSong) score += 60;
    else if (cTitle.startsWith(tSong) || tSong.startsWith(cTitle)) score += 46;
    else if (cTitle.includes(tSong) || tSong.includes(cTitle)) score += 34;
  }
  if (tArtist) {
    if (cArtist === tArtist) score += 35;
    else if (cArtist.includes(tArtist) || tArtist.includes(cArtist)) score += 25;
  }
  const combinedMeta = `${candidateTitle || ''} ${candidateArtist || ''}`;
  if (/纯音乐|instrumental|inst\b|ost|soundtrack|bgm|piano|orchestra|配乐|原声/i.test(combinedMeta)) {
    score += 14;
  }
  if (!/cover|翻唱|live|remix|dj|夜店|慢摇/i.test(String(candidateTitle || ''))) {
    score += 6;
  }
  if (hasDirectUrl) {
    score += 10;
  }
  return score;
}

async function checkNeteaseOuterPlayable(trackId) {
  if (!trackId) return '';
  const outerUrl = `https://music.163.com/song/media/outer/url?id=${trackId}.mp3`;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 2400);
    const r = await fetch(outerUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://music.163.com/'
      },
      signal: ctrl.signal
    });
    clearTimeout(tid);
    const finalUrl = r.url || '';
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (r.ok && !finalUrl.includes('/404') && !ct.includes('text/html')) {
      return `/api/music/stream?url=${encodeURIComponent(finalUrl || outerUrl)}`;
    }
  } catch (_) {}
  return '';
}

app.get('/api/music/stream', async (req, res) => {
  try {
    const rawUrl = String(req.query?.url || '').trim();
    if (!rawUrl) {
      return res.status(400).send('Missing url');
    }
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    if (rawUrl.includes('163.com') || rawUrl.includes('126.net')) {
      headers['Referer'] = 'https://music.163.com/';
    } else if (rawUrl.includes('qq.com') || rawUrl.includes('gtimg.cn')) {
      headers['Referer'] = 'https://y.qq.com/';
    }
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }
    const upstream = await fetch(rawUrl, { headers, redirect: 'follow' });
    const finalUrl = upstream.url || '';
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!upstream.ok || finalUrl.includes('/404') || ct.includes('text/html')) {
      return res.status(404).send('Audio stream unavailable');
    }
    res.status(upstream.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const cr = upstream.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);
    res.setHeader('Accept-Ranges', 'bytes');

    if (upstream.body) {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch (_) {}
      res.end();
    } else {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    }
  } catch (err) {
    res.status(500).send(err.message || 'Stream error');
  }
});

app.post('/api/music/search', async (req, res) => {
  try {
    const rawSong = String(req.body?.song || req.body?.keyword || '').trim();
    const rawArtist = String(req.body?.artist || '').trim();
    const sourcePref = String(req.body?.source || 'all').toLowerCase();
    if (!rawSong && !rawArtist) {
      return res.status(400).json({ error: 'Missing song or artist keyword' });
    }
    const cleanArtistForQuery = rawArtist.replace(/纯音乐|OST|原声带|伴奏/gi, '').trim();
    const queryKeyword = [rawSong, cleanArtistForQuery || rawArtist].filter(Boolean).join(' ').trim();
    const candidates = [];

    // 1. JD/GD Music Station API (netease / tencent multi-source)
    if (sourcePref === 'all' || sourcePref === 'gd' || sourcePref === 'jd' || sourcePref === 'netease' || sourcePref === 'qq') {
      const gdSources = sourcePref === 'qq' ? ['tencent', 'netease'] : ['netease', 'tencent'];
      for (const src of gdSources) {
        try {
          const gdSearchUrl = `https://music-api.gdstudio.xyz/api.php?types=search&source=${src}&name=${encodeURIComponent(queryKeyword)}&count=8&pages=1`;
          const gdRes = await fetch(gdSearchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (gdRes.ok) {
            const gdList = await gdRes.json();
            if (Array.isArray(gdList)) {
              for (const item of gdList.slice(0, 6)) {
                const title = String(item.name || '');
                const artist = Array.isArray(item.artist) ? item.artist.join(' / ') : String(item.artist || '');
                const trackId = item.url_id || item.id;
                candidates.push({
                  source: src === 'tencent' ? 'QQ音乐台' : 'JD音乐台·网易',
                  sourceCode: src,
                  trackId: String(trackId || ''),
                  title,
                  artist,
                  url: '',
                  score: calcMusicMatchScore(title, artist, rawSong || queryKeyword, cleanArtistForQuery || rawArtist, false)
                });
              }
            }
          }
        } catch (_) {}
      }
    }

    // 2. NetEase Cloud Music Official Search API
    if (sourcePref === 'all' || sourcePref === 'netease' || candidates.length === 0) {
      try {
        const neUrl = `https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${encodeURIComponent(queryKeyword)}&type=1&offset=0&total=true&limit=8`;
        const neRes = await fetch(neUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': 'https://music.163.com/'
          }
        });
        if (neRes.ok) {
          const neData = await neRes.json();
          const songs = neData?.result?.songs || [];
          for (const s of songs.slice(0, 6)) {
            const title = String(s.name || '');
            const artist = Array.isArray(s.artists) ? s.artists.map((a) => a.name).join(' / ') : '';
            if (s.id) {
              candidates.push({
                source: '网易云音乐',
                sourceCode: 'netease_web',
                trackId: String(s.id),
                title,
                artist,
                url: '',
                score: calcMusicMatchScore(title, artist, rawSong || queryKeyword, cleanArtistForQuery || rawArtist, false)
              });
            }
          }
        }
      } catch (_) {}
    }

    // 3. iTunes High-Availability Anime/Game Soundtrack Stream Search
    const searchItunesTerms = [queryKeyword];
    if (rawSong && cleanArtistForQuery && queryKeyword !== rawSong) {
      searchItunesTerms.push(`${rawSong} soundtrack`);
      searchItunesTerms.push(`${cleanArtistForQuery} soundtrack`);
    } else if (rawSong) {
      searchItunesTerms.push(`${rawSong} anime ost`);
    }
    for (const term of searchItunesTerms.slice(0, 2)) {
      try {
        const itUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=8`;
        const itRes = await fetch(itUrl);
        if (itRes.ok) {
          const itData = await itRes.json();
          for (const item of (itData?.results || []).slice(0, 6)) {
            if (!item.previewUrl) continue;
            const title = String(item.trackName || '');
            const artist = String(item.artistName || '');
            candidates.push({
              source: '动漫游戏原声台',
              sourceCode: 'itunes',
              trackId: String(item.trackId || ''),
              title,
              artist,
              url: `/api/music/stream?url=${encodeURIComponent(item.previewUrl)}`,
              rawStreamUrl: item.previewUrl,
              score: calcMusicMatchScore(title, artist, rawSong || term, cleanArtistForQuery || rawArtist, true) + 8
            });
          }
        }
      } catch (_) {}
    }

    // Sort by weight descending
    candidates.sort((a, b) => b.score - a.score);

    // Resolve and verify URLs for top candidates
    for (let i = 0; i < Math.min(6, candidates.length); i++) {
      const cand = candidates[i];
      if (!cand.url && cand.trackId) {
        if (cand.sourceCode === 'netease' || cand.sourceCode === 'tencent') {
          try {
            const uRes = await fetch(`https://music-api.gdstudio.xyz/api.php?types=url&source=${cand.sourceCode}&id=${encodeURIComponent(cand.trackId)}&br=320`, {
              headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (uRes.ok) {
              const uData = await uRes.json();
              if (uData && uData.url) {
                cand.url = `/api/music/stream?url=${encodeURIComponent(uData.url)}`;
                cand.score += 12;
              }
            }
          } catch (_) {}
        }
        if (!cand.url && (cand.sourceCode === 'netease' || cand.sourceCode === 'netease_web')) {
          const verifiedUrl = await checkNeteaseOuterPlayable(cand.trackId);
          if (verifiedUrl) {
            cand.url = verifiedUrl;
            cand.score += 10;
          }
        }
      }
    }

    const playable = candidates.filter((c) => Boolean(c.url));
    playable.sort((a, b) => b.score - a.score);

    return res.json({
      ok: true,
      query: { song: rawSong, artist: rawArtist },
      best: playable[0] || null,
      candidates: playable.slice(0, 10)
    });
  } catch (err) {
    console.error('Music search error:', err);
    return res.status(500).json({ error: err.message || 'Music search failed' });
  }
});

// Peer communication hub and offline mailbox
const MAILBOX_STORE_PATH = path.join(__dirname, '.peer-mailbox-store.json');
const peerClients = new Map();
const peerMailboxes = new Map();
const peerProfiles = new Map();
const peerLastPoll = new Map();

const EPHEMERAL_EVENT_TYPES = new Set([
  'online_ping',
  'online_pong',
  'offline_ping',
  'peer_presence',
  'group_typing_status',
  'peer_ack'
]);

function sanitizeMailboxEventsForDisk(events) {
  if (!Array.isArray(events)) return [];
  const now = Date.now();
  const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
  return events
    .filter((item) => {
      if (!item || typeof item !== 'object') return false;
      if (EPHEMERAL_EVENT_TYPES.has(item.type)) return false;
      if (item.timestamp && now - item.timestamp > maxAgeMs) return false;
      return true;
    })
    .slice(-100);
}

function loadMailboxStoreFromDisk() {
  try {
    if (fs.existsSync(MAILBOX_STORE_PATH)) {
      const raw = fs.readFileSync(MAILBOX_STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      let needsResave = false;
      if (parsed && parsed.mailboxes && typeof parsed.mailboxes === 'object') {
        for (const [k, v] of Object.entries(parsed.mailboxes)) {
          if (Array.isArray(v)) {
            const cleaned = sanitizeMailboxEventsForDisk(v);
            if (cleaned.length !== v.length) needsResave = true;
            if (cleaned.length > 0) {
              peerMailboxes.set(k, cleaned);
            }
          }
        }
      }
      if (parsed && parsed.profiles && typeof parsed.profiles === 'object') {
        for (const [k, v] of Object.entries(parsed.profiles)) {
          if (v && typeof v === 'object') peerProfiles.set(k, v);
        }
      }
      if (needsResave) {
        scheduleSaveMailboxStore();
      }
    }
  } catch (e) {
    console.warn('[PeerStore] Load warning:', e.message);
  }
}

let saveStoreTimer = null;
function scheduleSaveMailboxStore() {
  if (saveStoreTimer) clearTimeout(saveStoreTimer);
  saveStoreTimer = setTimeout(() => {
    try {
      const mailboxesObj = {};
      for (const [k, v] of peerMailboxes.entries()) {
        if (Array.isArray(v) && v.length > 0) {
          const cleaned = sanitizeMailboxEventsForDisk(v);
          if (cleaned.length > 0) {
            mailboxesObj[k] = cleaned;
          }
        }
      }
      const profilesObj = {};
      for (const [k, v] of peerProfiles.entries()) {
        profilesObj[k] = v;
      }
      fs.promises
        .writeFile(MAILBOX_STORE_PATH, JSON.stringify({ mailboxes: mailboxesObj, profiles: profilesObj }), 'utf8')
        .catch((e) => console.warn('[PeerStore] Save warning:', e.message));
    } catch (e) {
      console.warn('[PeerStore] Save warning:', e.message);
    }
  }, 1200);
}

loadMailboxStoreFromDisk();

const peerWaitingPollers = new Map();

function pushToMailbox(code, event) {
  if (!code || !event) return;
  if (!peerMailboxes.has(code)) {
    peerMailboxes.set(code, []);
  }
  let box = peerMailboxes.get(code);
  if (event.eventId && box.some(item => item && item.eventId === event.eventId)) {
    return;
  }
  if (event.type === 'group_typing_status') {
    box = box.filter(item => !(item && item.type === 'group_typing_status' && item.fromCode === event.fromCode));
  } else if (event.type === 'group_member_update' && event.groupId) {
    box = box.filter(item => !(item && item.type === 'group_member_update' && String(item.groupId) === String(event.groupId)));
  } else if (event.type === 'profile_update' && (event.peerCode || event.fromCode)) {
    const pCode = event.peerCode || event.fromCode;
    box = box.filter(item => !(item && item.type === 'profile_update' && (item.peerCode === pCode || item.fromCode === pCode)));
  } else if (event.type === 'peer_ack' && event.ackEventId) {
    box = box.filter(item => !(item && item.type === 'peer_ack' && item.ackEventId === event.ackEventId));
  }
  box.push(event);
  if (box.length > 150) {
    const nonEphemeral = box.filter(item => item && !EPHEMERAL_EVENT_TYPES.has(item.type));
    if (nonEphemeral.length <= 150) {
      box = nonEphemeral;
    } else {
      box = nonEphemeral.slice(-150);
    }
  }
  peerMailboxes.set(code, box);
  if (!EPHEMERAL_EVENT_TYPES.has(event.type)) {
    scheduleSaveMailboxStore();
  }

  const waitSet = peerWaitingPollers.get(code);
  if (waitSet && waitSet.size > 0) {
    const list = Array.from(waitSet);
    waitSet.clear();
    for (const item of list) {
      if (item && item.timer) clearTimeout(item.timer);
      if (item && item.res && !item.res.headersSent) {
        try {
          item.res.json({ success: true, events: [event], profile: peerProfiles.get(code) || null, onlinePeers: {} });
        } catch (_) {}
      }
    }
  }
}

function ackFromMailbox(code, eventIds) {
  if (!code || !Array.isArray(eventIds) || eventIds.length === 0) return;
  if (!peerMailboxes.has(code)) return;
  const idSet = new Set(eventIds);
  const box = peerMailboxes.get(code) || [];
  const filtered = box.filter(item => !item || !item.eventId || !idSet.has(item.eventId));
  peerMailboxes.set(code, filtered);
  scheduleSaveMailboxStore();
}

function sendToPeerWs(code, event) {
  const clients = peerClients.get(code);
  let delivered = false;
  if (clients && clients.size > 0) {
    const payload = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(payload);
        delivered = true;
      }
    }
  }
  return delivered;
}

app.post('/api/peer/register', (req, res) => {
  const { peerCode, name, avatar, myAvatarFrame } = req.body;
  if (!peerCode) return res.status(400).json({ error: 'Missing peerCode' });
  const normCode = String(peerCode).trim().toUpperCase();
  peerLastPoll.set(normCode, Date.now());
  peerProfiles.set(normCode, { name, avatar, myAvatarFrame, lastSeen: Date.now() });
  scheduleSaveMailboxStore();
  return res.json({ success: true });
});

function pushPresenceToMailbox(code, event) {
  if (!code || !event) return;
  if (!peerMailboxes.has(code)) {
    peerMailboxes.set(code, []);
  }
  const box = peerMailboxes.get(code);
  const filtered = box.filter(item => !(item && (item.type === 'online_ping' || item.type === 'online_pong' || item.type === 'offline_ping') && item.fromCode === event.fromCode));
  filtered.push(event);
  if (filtered.length > 200) {
    filtered.shift();
  }
  peerMailboxes.set(code, filtered);
}

app.post('/api/peer/send', (req, res) => {
  const body = req.body || {};
  const {
    type = 'message',
    eventId,
    ackEventId,
    fromCode,
    toCode,
    content,
    msgType,
    audioData,
    audioDuration,
    meaning,
    isPeerOnlySticker,
    senderName,
    senderAvatar,
    senderAvatarFrame,
    peerAvatarFrame,
    timestamp
  } = body;
  if (!toCode) return res.status(400).json({ error: 'Missing target' });
  const normFrom = fromCode ? String(fromCode).trim().toUpperCase() : '';
  const normTo = String(toCode).trim().toUpperCase();

  if (normFrom && type !== 'offline_ping') {
    peerLastPoll.set(normFrom, Date.now());
  }

  if (type === 'peer_ack') {
    const ackEvt = {
      type: 'peer_ack',
      eventId: eventId || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
      ackEventId,
      fromCode: normFrom || fromCode,
      toCode: normTo,
      timestamp: Date.now()
    };
    sendToPeerWs(normTo, ackEvt);
    pushToMailbox(normTo, ackEvt);
    return res.json({ success: true });
  }

  if (type === 'online_ping' || type === 'online_pong' || type === 'offline_ping') {
    if (normFrom) {
      if (type === 'offline_ping') {
        peerLastPoll.delete(normFrom);
        if (peerClients.has(normFrom)) {
          peerClients.delete(normFrom);
        }
      } else {
        peerLastPoll.set(normFrom, Date.now());
      }
    }
    const pingEvt = {
      type,
      eventId: eventId || ('ping_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
      fromCode: normFrom || fromCode,
      toCode: normTo,
      timestamp: Date.now()
    };
    const delivered = sendToPeerWs(normTo, pingEvt);
    if (!delivered) {
      pushPresenceToMailbox(normTo, pingEvt);
    }
    return res.json({ success: true });
  }

  if (type !== 'message') {
    const customEvent = {
      ...body,
      type,
      fromCode: normFrom || fromCode,
      toCode: normTo,
      eventId: eventId || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
      timestamp: timestamp || Date.now()
    };
    const delivered = sendToPeerWs(normTo, customEvent);
    pushToMailbox(normTo, customEvent);
    return res.json({ success: true, delivered });
  }

  if (!content && !audioData) return res.status(400).json({ error: 'Missing content' });
  const event = {
    ...body,
    type: 'message',
    eventId: eventId || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    fromCode: normFrom || fromCode,
    toCode: normTo,
    content: content || '[语音消息]',
    msgType: msgType || 'text',
    meaning: meaning || '',
    isPeerOnlySticker: Boolean(isPeerOnlySticker),
    audioData: audioData || '',
    audioDuration: audioDuration || 0,
    senderName,
    senderAvatar,
    senderAvatarFrame: senderAvatarFrame || '',
    peerAvatarFrame: peerAvatarFrame || '',
    timestamp: timestamp || Date.now()
  };
  const delivered = sendToPeerWs(normTo, event);
  pushToMailbox(normTo, event);
  return res.json({ success: true, delivered });
});

app.post('/api/peer/profile', (req, res) => {
  const { eventId, peerCode, name, avatar, myAvatarFrame, peerAvatarFrame, targetCodes = [] } = req.body;
  if (!peerCode) return res.status(400).json({ error: 'Missing peerCode' });
  const normCode = String(peerCode).trim().toUpperCase();
  peerLastPoll.set(normCode, Date.now());
  peerProfiles.set(normCode, { name, avatar, myAvatarFrame, lastSeen: Date.now() });
  scheduleSaveMailboxStore();
  const event = {
    type: 'profile_update',
    eventId: eventId || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    peerCode: normCode,
    name,
    avatar,
    myAvatarFrame: myAvatarFrame !== undefined ? myAvatarFrame : undefined,
    peerAvatarFrame: peerAvatarFrame !== undefined ? peerAvatarFrame : undefined,
    timestamp: Date.now()
  };
  if (Array.isArray(targetCodes)) {
    for (const target of targetCodes) {
      const normTarget = String(target).trim().toUpperCase();
      sendToPeerWs(normTarget, event);
      pushToMailbox(normTarget, event);
    }
  }
  return res.json({ success: true });
});

app.post('/api/peer/request', (req, res) => {
  const { type = 'friend_request', eventId, fromCode, toCode, fromName, fromAvatar, fromAvatarFrame } = req.body;
  if (!toCode) return res.status(400).json({ error: 'Missing target' });
  const normFrom = fromCode ? String(fromCode).trim().toUpperCase() : '';
  const normTo = String(toCode).trim().toUpperCase();
  if (normFrom) peerLastPoll.set(normFrom, Date.now());
  const event = {
    type: type === 'friend_accept' ? 'friend_accept' : 'friend_request',
    eventId: eventId || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    fromCode: normFrom || fromCode,
    toCode: normTo,
    fromName,
    fromAvatar,
    fromAvatarFrame: fromAvatarFrame || '',
    timestamp: Date.now()
  };
  sendToPeerWs(normTo, event);
  pushToMailbox(normTo, event);
  return res.json({ success: true });
});

app.post('/api/peer/ack', (req, res) => {
  const { peerCode, eventIds = [] } = req.body;
  if (!peerCode) return res.status(400).json({ error: 'Missing peerCode' });
  const normCode = String(peerCode).trim().toUpperCase();
  peerLastPoll.set(normCode, Date.now());
  ackFromMailbox(normCode, eventIds);
  return res.json({ success: true });
});

app.get('/api/peer/poll', (req, res) => {
  const rawCode = req.query.code;
  if (!rawCode) return res.status(400).json({ error: 'Missing code' });
  const code = String(rawCode).trim().toUpperCase();
  peerLastPoll.set(code, Date.now());
  const events = peerMailboxes.get(code) || [];
  const profile = peerProfiles.get(code) || null;
  const onlinePeers = {};
  if (typeof req.query.peers === 'string' && req.query.peers.trim()) {
    const now = Date.now();
    req.query.peers.split(',').forEach((p) => {
      const pCode = p.trim().toUpperCase();
      if (!pCode) return;
      const wsSet = peerClients.get(pCode);
      const hasWs = Boolean(wsSet && wsSet.size > 0);
      const lastSeen = peerLastPoll.get(pCode) || 0;
      onlinePeers[pCode] = Boolean(hasWs || (lastSeen > 0 && now - lastSeen < 25000));
    });
  }

  if (events.length > 0 || req.query.wait === '0') {
    return res.json({ success: true, events, profile, onlinePeers });
  }

  if (!peerWaitingPollers.has(code)) {
    peerWaitingPollers.set(code, new Set());
  }
  const pollers = peerWaitingPollers.get(code);
  const entry = { res, timer: null };

  const done = (evts) => {
    if (entry.timer) clearTimeout(entry.timer);
    pollers.delete(entry);
    if (!res.headersSent) {
      try {
        res.json({ success: true, events: evts || peerMailboxes.get(code) || [], profile, onlinePeers });
      } catch (_) {}
    }
  };

  entry.timer = setTimeout(() => {
    done([]);
  }, 25000);

  req.on('close', () => {
    if (entry.timer) clearTimeout(entry.timer);
    pollers.delete(entry);
  });

  pollers.add(entry);
});

app.use(express.static(__dirname));

// Client-side fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let boundCode = null;

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'register') {
        boundCode = data.peerCode ? String(data.peerCode).trim().toUpperCase() : null;
        if (boundCode) {
          if (!peerClients.has(boundCode)) {
            peerClients.set(boundCode, new Set());
          }
          peerClients.get(boundCode).add(ws);
          peerLastPoll.set(boundCode, Date.now());
          if (data.name || data.avatar) {
            peerProfiles.set(boundCode, {
              name: data.name,
              avatar: data.avatar,
              myAvatarFrame: data.myAvatarFrame || '',
              lastSeen: Date.now()
            });
            scheduleSaveMailboxStore();
          }
          const onlineEvt = {
            type: 'peer_presence',
            status: 'online',
            peerCode: boundCode,
            timestamp: Date.now()
          };
          for (const [otherCode, clientSet] of peerClients.entries()) {
            if (otherCode !== boundCode) {
              for (const otherWs of clientSet) {
                if (otherWs.readyState === 1) {
                  try {
                    otherWs.send(JSON.stringify(onlineEvt));
                  } catch (e) {}
                }
              }
            }
          }
          const box = peerMailboxes.get(boundCode) || [];
          if (box.length > 0) {
            box.forEach(evt => ws.send(JSON.stringify(evt)));
          }
        }
      } else if (data.type === 'ack') {
        const targetCode = String(data.peerCode || boundCode || '').trim().toUpperCase();
        if (targetCode) peerLastPoll.set(targetCode, Date.now());
        if (targetCode && Array.isArray(data.eventIds)) {
          ackFromMailbox(targetCode, data.eventIds);
        }
      } else if (data.type === 'peer_ack') {
        const { eventId, ackEventId, fromCode, toCode } = data;
        const normFrom = String(fromCode || boundCode || '').trim().toUpperCase();
        const normTo = String(toCode || '').trim().toUpperCase();
        if (normFrom) peerLastPoll.set(normFrom, Date.now());
        if (normTo) {
          const ackEvt = {
            type: 'peer_ack',
            eventId: eventId || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
            ackEventId,
            fromCode: normFrom,
            toCode: normTo,
            timestamp: Date.now()
          };
          sendToPeerWs(normTo, ackEvt);
          pushToMailbox(normTo, ackEvt);
        }
      } else if (data.type === 'message') {
        const {
          eventId,
          fromCode,
          toCode,
          content,
          msgType,
          audioData,
          audioDuration,
          senderName,
          senderAvatar,
          senderAvatarFrame,
          peerAvatarFrame,
          timestamp
        } = data;
        const normFrom = String(fromCode || boundCode || '').trim().toUpperCase();
        const normTo = String(toCode || '').trim().toUpperCase();
        if (normFrom) peerLastPoll.set(normFrom, Date.now());
        if (normTo) {
          const event = {
            type: 'message',
            eventId: eventId || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
            fromCode: normFrom,
            toCode: normTo,
            content: content || '[语音消息]',
            msgType: msgType || 'text',
            audioData: audioData || '',
            audioDuration: audioDuration || 0,
            senderName,
            senderAvatar,
            senderAvatarFrame: senderAvatarFrame || '',
            peerAvatarFrame: peerAvatarFrame || '',
            timestamp: timestamp || Date.now()
          };
          sendToPeerWs(normTo, event);
          pushToMailbox(normTo, event);
        }
      } else if (data.type === 'profile_update') {
        const { eventId, peerCode, name, avatar, myAvatarFrame, peerAvatarFrame, targetCodes = [] } = data;
        const normCode = String(peerCode || boundCode || '').trim().toUpperCase();
        if (normCode) peerLastPoll.set(normCode, Date.now());
        peerProfiles.set(normCode, { name, avatar, myAvatarFrame, lastSeen: Date.now() });
        scheduleSaveMailboxStore();
        const event = {
          type: 'profile_update',
          eventId: eventId || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
          peerCode: normCode,
          name,
          avatar,
          myAvatarFrame: myAvatarFrame !== undefined ? myAvatarFrame : undefined,
          peerAvatarFrame: peerAvatarFrame !== undefined ? peerAvatarFrame : undefined,
          timestamp: Date.now()
        };
        if (Array.isArray(targetCodes)) {
          targetCodes.forEach(target => {
            const normTarget = String(target).trim().toUpperCase();
            sendToPeerWs(normTarget, event);
            pushToMailbox(normTarget, event);
          });
        }
      } else if (data.type === 'friend_request' || data.type === 'friend_accept') {
        const { eventId, fromCode, toCode, fromName, fromAvatar, fromAvatarFrame } = data;
        const normFrom = String(fromCode || boundCode || '').trim().toUpperCase();
        const normTo = String(toCode || '').trim().toUpperCase();
        if (normFrom) peerLastPoll.set(normFrom, Date.now());
        const event = {
          type: data.type,
          eventId: eventId || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
          fromCode: normFrom,
          toCode: normTo,
          fromName,
          fromAvatar,
          fromAvatarFrame: fromAvatarFrame || '',
          timestamp: Date.now()
        };
        sendToPeerWs(normTo, event);
        pushToMailbox(normTo, event);
      } else if (data.type === 'online_ping' || data.type === 'online_pong' || data.type === 'offline_ping') {
        const normFrom = String(data.fromCode || boundCode || '').trim().toUpperCase();
        const normTo = String(data.toCode || '').trim().toUpperCase();
        if (normFrom) {
          if (data.type === 'offline_ping') {
            peerLastPoll.delete(normFrom);
            if (peerClients.has(normFrom)) {
              peerClients.delete(normFrom);
            }
          } else {
            peerLastPoll.set(normFrom, Date.now());
          }
        }
        if (normTo) {
          const pingEvt = {
            type: data.type,
            eventId: data.eventId || ('ping_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
            fromCode: normFrom,
            toCode: normTo,
            timestamp: Date.now()
          };
          const delivered = sendToPeerWs(normTo, pingEvt);
          if (!delivered) {
            pushPresenceToMailbox(normTo, pingEvt);
          }
        }
      } else if (data.toCode) {
        const normFrom = String(data.fromCode || boundCode || '').trim().toUpperCase();
        const normTo = String(data.toCode || '').trim().toUpperCase();
        if (normFrom) peerLastPoll.set(normFrom, Date.now());
        const customEvent = {
          ...data,
          fromCode: normFrom || data.fromCode,
          toCode: normTo,
          eventId: data.eventId || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
          timestamp: data.timestamp || Date.now()
        };
        sendToPeerWs(normTo, customEvent);
        pushToMailbox(normTo, customEvent);
      }
    } catch (e) {
      console.warn('[WS] Parse error:', e.message);
    }
  });

  ws.on('error', (err) => {
    console.warn('[WS] Client socket error:', err.message);
  });

  ws.on('close', () => {
    if (boundCode && peerClients.has(boundCode)) {
      peerClients.get(boundCode).delete(ws);
      if (peerClients.get(boundCode).size === 0) {
        peerClients.delete(boundCode);
      }
    }
  });
});

wss.on('error', (err) => {
  console.warn('[WSS] Server error:', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason);
});

server.timeout = 600000;
server.requestTimeout = 600000;
server.headersTimeout = 610000;
server.keepAliveTimeout = 600000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});



