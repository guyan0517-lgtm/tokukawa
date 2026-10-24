import fs from 'fs';
import os from 'os';
import http from 'http';
import crypto from 'crypto';
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

app.use(express.json({ limit: '250mb' }));
app.use(express.urlencoded({ extended: true, limit: '250mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

const LOCAL_ASSET_CANDIDATES = [
  path.join(os.homedir(), '.HakoniwaVault'),
  path.join(__dirname, '.HakoniwaVault')
];
const LEGACY_PUBLIC_DIRS = [
  path.join(os.homedir(), 'storage', 'shared', 'Download', 'HakoniwaData'),
  path.join(os.homedir(), 'storage', 'shared', 'HakoniwaData'),
  '/sdcard/Download/HakoniwaData',
  '/sdcard/HakoniwaData',
  '/storage/emulated/0/Download/HakoniwaData',
  '/storage/emulated/0/HakoniwaData',
  path.join(os.homedir(), 'storage', 'shared', 'Download', '.HakoniwaVault'),
  path.join(os.homedir(), 'storage', 'shared', '.HakoniwaVault'),
  '/sdcard/Download/.HakoniwaVault',
  '/sdcard/.HakoniwaVault',
  '/storage/emulated/0/Download/.HakoniwaVault',
  '/storage/emulated/0/.HakoniwaVault',
  path.join(os.homedir(), 'HakoniwaData'),
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

function toVaultDiskPath(filePath) {
  if (filePath.endsWith('.nomedia') || filePath.endsWith('.wt') || filePath.endsWith('.hknw')) {
    return filePath;
  }
  return filePath + '.hknw';
}

function stripVaultDiskSuffix(relPath) {
  return relPath.endsWith('.hknw') ? relPath.slice(0, -5) : relPath;
}

function disguiseExistingFilesInVaultSync(vaultDir) {
  try {
    if (!fs.existsSync(vaultDir)) return;
    const walk = (d) => {
      ensureNoMediaInDirSync(d);
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile() && ent.name !== '.nomedia' && ent.name !== '.wt' && !ent.name.endsWith('.hknw')) {
          try {
            const disguised = full + '.hknw';
            if (fs.existsSync(disguised)) fs.unlinkSync(disguised);
            fs.renameSync(full, disguised);
          } catch (_) {}
        }
      }
    };
    walk(vaultDir);
  } catch (_) {}
}

function migrateLegacyDirToVaultSync(legacyDir, vaultDir) {
  let movedCount = 0;
  try {
    if (!fs.existsSync(legacyDir) || path.resolve(legacyDir) === path.resolve(vaultDir)) return 0;
    ensureNoMediaInDirSync(vaultDir);
    const walkMove = (srcDir, dstDir) => {
      ensureNoMediaInDirSync(dstDir);
      const entries = fs.readdirSync(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        const sFull = path.join(srcDir, entry.name);
        const dFull = path.join(dstDir, entry.name);
        if (entry.isDirectory()) {
          walkMove(sFull, dFull);
          try { fs.rmdirSync(sFull); } catch (_) {}
        } else if (entry.isFile()) {
          if (entry.name !== '.wt' && entry.name !== '.nomedia') {
            try {
              const targetDisk = toVaultDiskPath(dFull);
              fs.mkdirSync(path.dirname(targetDisk), { recursive: true });
              ensureNoMediaInDirSync(path.dirname(targetDisk));
              fs.copyFileSync(sFull, targetDisk);
              movedCount += 1;
            } catch (_) {}
          }
          try { fs.unlinkSync(sFull); } catch (_) {}
        }
      }
    };
    walkMove(legacyDir, vaultDir);
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch (_) {}
  } catch (_) {}
  return movedCount;
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
for (const legacyDir of LEGACY_PUBLIC_DIRS) {
  migrateLegacyDirToVaultSync(legacyDir, LOCAL_ASSETS_ROOT);
}
disguiseExistingFilesInVaultSync(LOCAL_ASSETS_ROOT);

function guessAssetMimeType(filePath) {
  const clean = stripVaultDiskSuffix(String(filePath || '')).toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif')) return 'image/gif';
  if (clean.endsWith('.mp3')) return 'audio/mpeg';
  if (clean.endsWith('.wav')) return 'audio/wav';
  if (clean.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

app.use('/local-assets', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  try {
    const rawRel = decodeURIComponent(req.path || '').replace(/^\/+/, '').replace(/\.\./g, '_');
    if (!rawRel) return res.status(404).end();
    const rootAbs = path.resolve(LOCAL_ASSETS_ROOT);
    const plainPath = path.resolve(rootAbs, rawRel);
    if (!plainPath.startsWith(rootAbs)) return res.status(400).end();
    const hknwPath = toVaultDiskPath(plainPath);
    let actualPath = '';
    if (fs.existsSync(hknwPath) && fs.statSync(hknwPath).isFile()) {
      actualPath = hknwPath;
    } else if (fs.existsSync(plainPath) && fs.statSync(plainPath).isFile()) {
      try {
        fs.renameSync(plainPath, hknwPath);
        actualPath = hknwPath;
      } catch (_) {
        actualPath = plainPath;
      }
    }
    if (!actualPath) return res.status(404).end();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', guessAssetMimeType(rawRel));
    return res.sendFile(actualPath);
  } catch (_) {
    return res.status(404).end();
  }
});

app.get('/api/local-assets/ping', (_req, res) => {
  ensureNoMediaInDirSync(LOCAL_ASSETS_ROOT);
  res.json({
    ok: true,
    service: 'hakoniwa-local-bridge',
    version: 4,
    mode: 'server',
    root: LOCAL_ASSETS_ROOT
  });
});

app.get('/api/local-assets/list', async (_req, res) => {
  try {
    const rootAbs = path.resolve(LOCAL_ASSETS_ROOT);
    const files = [];
    const walk = async (dirPath) => {
      let entries = [];
      try {
        entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const ent of entries) {
        if (ent.name === '.wt' || ent.name === '.nomedia') continue;
        const full = path.join(dirPath, ent.name);
        if (ent.isDirectory()) {
          await walk(full);
        } else if (ent.isFile()) {
          const rawRel = path.relative(rootAbs, full).split(path.sep).join('/');
          files.push(stripVaultDiskSuffix(rawRel));
        }
      }
    };
    await walk(rootAbs);
    res.json({ ok: true, files, root: LOCAL_ASSETS_ROOT });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, files: [] });
  }
});

app.post('/api/local-assets/hide-gallery', (_req, res) => {
  let migrated = 0;
  ensureNoMediaInDirSync(LOCAL_ASSETS_ROOT);
  for (const legacyDir of LEGACY_PUBLIC_DIRS) {
    migrated += migrateLegacyDirToVaultSync(legacyDir, LOCAL_ASSETS_ROOT);
  }
  disguiseExistingFilesInVaultSync(LOCAL_ASSETS_ROOT);
  res.json({
    ok: true,
    version: 3,
    migratedCount: migrated,
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
    const plainTarget = path.resolve(LOCAL_ASSETS_ROOT, rawRel);
    if (!plainTarget.startsWith(path.resolve(LOCAL_ASSETS_ROOT))) {
      return res.status(400).json({ ok: false, error: 'Invalid path' });
    }
    const targetPath = toVaultDiskPath(plainTarget);
    const targetDir = path.dirname(targetPath);
    await fs.promises.mkdir(targetDir, { recursive: true });
    ensureNoMediaInDirSync(LOCAL_ASSETS_ROOT);
    ensureNoMediaInDirSync(targetDir);
    await fs.promises.writeFile(targetPath, fileBuf);
    if (plainTarget !== targetPath && fs.existsSync(plainTarget)) {
      await fs.promises.unlink(plainTarget).catch(() => {});
    }
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

app.post('/api/local-assets/save-batch', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const rootAbs = path.resolve(LOCAL_ASSETS_ROOT);
    ensureNoMediaInDirSync(LOCAL_ASSETS_ROOT);
    let savedCount = 0;
    const savedDirs = new Set();

    await Promise.all(
      items.map(async (item) => {
        try {
          const rawRel = String(item?.path || item?.relPath || '').split('?')[0].replace(/^\/+/, '').replace(/\.\./g, '_');
          const dataUrl = String(item?.dataUrl || '');
          if (!rawRel || !dataUrl) return;
          const plainTarget = path.resolve(rootAbs, rawRel);
          if (!plainTarget.startsWith(rootAbs)) return;
          const targetPath = toVaultDiskPath(plainTarget);
          const targetDir = path.dirname(targetPath);
          if (!savedDirs.has(targetDir)) {
            await fs.promises.mkdir(targetDir, { recursive: true });
            ensureNoMediaInDirSync(targetDir);
            savedDirs.add(targetDir);
          }
          const base64Part = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
          const fileBuf = base64Part ? Buffer.from(base64Part, 'base64') : Buffer.alloc(0);
          await fs.promises.writeFile(targetPath, fileBuf);
          savedCount += 1;
        } catch (_) {}
      })
    );

    res.json({
      ok: true,
      savedCount,
      root: LOCAL_ASSETS_ROOT
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/local-assets/cleanup', async (req, res) => {
  try {
    for (const legacyDir of LEGACY_PUBLIC_DIRS) {
      migrateLegacyDirToVaultSync(legacyDir, LOCAL_ASSETS_ROOT);
    }
    const activeRelList = Array.isArray(req.body?.activePaths) ? req.body.activePaths : [];
    const activeSet = new Set(
      activeRelList.map((p) => stripVaultDiskSuffix(String(p || '').split('?')[0].replace(/^\/+/, '').replace(/\.\./g, '_')))
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
          const rawRel = path.relative(rootAbs, fullPath).split(path.sep).join('/');
          const baseRel = stripVaultDiskSuffix(rawRel);
          const isProtectedAsset =
            baseRel.startsWith('characters/') ||
            baseRel.startsWith('projects/') ||
            baseRel.startsWith('audio/') ||
            baseRel.startsWith('fonts/');
          if (!isProtectedAsset && !activeSet.has(baseRel)) {
            try {
              await fs.promises.unlink(fullPath);
              removedCount += 1;
            } catch (_) {}
          } else if (!fullPath.endsWith('.hknw')) {
            try {
              const hknwFull = fullPath + '.hknw';
              if (fs.existsSync(hknwFull)) await fs.promises.unlink(hknwFull).catch(() => {});
              await fs.promises.rename(fullPath, hknwFull);
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

function analyzeLyricTextForInstrumental(rawLyric) {
  const txt = String(rawLyric || '').trim();
  if (!txt) {
    return { isInstrumental: true, hasVocals: false };
  }
  if (/纯音乐\s*[，,、\s]*请欣赏|纯音乐\s*[，,、\s]*敬请欣赏|此歌曲为没有填词的纯音乐|没有填词的纯音乐|纯音乐无歌词|no\s*lyrics|instrumental\s*track/i.test(txt)) {
    return { isInstrumental: true, hasVocals: false };
  }
  const lines = txt.split(/\r?\n/);
  let sungLineCount = 0;
  for (const rawLine of lines) {
    const hasTimeTag = /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(rawLine);
    const cleaned = rawLine.replace(/\[[^\]]*\]/g, '').trim();
    if (!cleaned) continue;
    if (/^(作词|作曲|编曲|制作人?|プロデューサー|录音|混音|母带|弦乐|吉他|钢琴|贝斯|鼓|提琴|长笛|竖琴|管弦|和声|配唱|出品|发行|企划|监制|统筹|原曲|翻唱|词|曲|编|唱|歌|演奏|指挥|乐团|录音棚|lyricist|lyrics?|composer|composed|arranger|arranged|producer|produced|mixed|mastered|vocal|instrument|bgm|ost|soundtrack|纯音乐|伴奏)\s*[:：\/｜|]/i.test(cleaned)) {
      continue;
    }
    if (/^(纯音乐|伴奏|无人声|instrumental|inst\.?|ost)$/i.test(cleaned)) {
      continue;
    }
    if (hasTimeTag && cleaned.length >= 2) {
      sungLineCount += 1;
    }
  }
  if (sungLineCount >= 3) {
    return { isInstrumental: false, hasVocals: true, sungLineCount };
  }
  return { isInstrumental: true, hasVocals: false, sungLineCount };
}

async function inspectTrackLyricsForVocals(sourceCode, trackId) {
  if (!trackId) return { isInstrumental: false, hasVocals: false };
  if (sourceCode === 'netease' || sourceCode === 'netease_web') {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 1800);
      const neLyricUrl = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(trackId)}&lv=1&kv=1&tv=-1`;
      const r = await fetch(neLyricUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': 'https://music.163.com/'
        },
        signal: ctrl.signal
      });
      clearTimeout(tid);
      if (r.ok) {
        const d = await r.json();
        if (d && (d.nolyric === true || d.uncollected === true)) {
          return { isInstrumental: true, hasVocals: false };
        }
        const rawLrc = d?.lrc?.lyric || '';
        return analyzeLyricTextForInstrumental(rawLrc);
      }
    } catch (_) {}
  }
  if (sourceCode === 'netease' || sourceCode === 'tencent' || sourceCode === 'netease_web') {
    const gdSrc = sourceCode === 'netease_web' ? 'netease' : sourceCode;
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 1800);
      const gdLyricUrl = `https://music-api.gdstudio.xyz/api.php?types=lyric&source=${gdSrc}&id=${encodeURIComponent(trackId)}`;
      const r = await fetch(gdLyricUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: ctrl.signal
      });
      clearTimeout(tid);
      if (r.ok) {
        const d = await r.json();
        const rawLrc = d?.lyric || '';
        return analyzeLyricTextForInstrumental(rawLrc);
      }
    } catch (_) {}
  }
  return { isInstrumental: false, hasVocals: false };
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
    if (cArtist === tArtist) score += 38;
    else if (cArtist.includes(tArtist) || tArtist.includes(cArtist)) score += 26;
  }
  const combinedMeta = `${candidateTitle || ''} ${candidateArtist || ''}`;
  if (/纯音乐|伴奏|无人声|instrumental|inst\b|ost|original soundtrack|soundtrack|bgm|piano|orchestra|string|violin|cello|flute|music box|オルゴール|サウンドトラック|アンサンブル|配乐|原声|日乙|乙女|otome|drama|抓马|galgame|visual novel|文字游戏/i.test(combinedMeta)) {
    score += 45;
  }
  if (/泽野弘之|梶浦由记|神前晓|折户伸治|高梨康治|川井宪次|牛尾宪辅|光田康典|下村阳子|横山克|林友树|吉森信|天门|麻枝准|key sounds|falcom|type-moon|nitro|chiral|otomate|rejet|arisu|onoken|sakuzyo|久石让|坂本龙一/i.test(combinedMeta)) {
    score += 30;
  }
  if (/cover|翻唱|live|演唱会|现场版|remix|dj|夜店|慢摇|feat\.|合唱|人声|vocal|歌ってみた|karaoke|卡拉ok|抖音|热歌|片头曲|片尾曲|主题曲|op\b|ed\b|角色歌/i.test(combinedMeta)) {
    score -= 90;
  } else {
    score += 8;
  }
  if (hasDirectUrl) {
    score += 12;
  }
  return score;
}

async function checkNeteaseOuterPlayable(trackId) {
  if (!trackId) return '';
  const outerUrl = `https://music.163.com/song/media/outer/url?id=${trackId}.mp3`;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 1600);
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
    const cleanArtistForQuery = rawArtist.replace(/^(纯音乐|OST|原声带|伴奏)$/gi, '').trim();
    const baseKeyword = [rawSong, cleanArtistForQuery || rawArtist].filter(Boolean).join(' ').trim();
    const hasInstHint = /纯音乐|ost|soundtrack|instrumental|bgm|原声|伴奏/i.test(baseKeyword);
    const queryKeyword = hasInstHint ? baseKeyword : `${baseKeyword} 纯音乐 OST`;
    const candidates = [];

    const tasks = [];

    // 1. JD/GD Music Station API (netease / tencent multi-source)
    if (sourcePref === 'all' || sourcePref === 'gd' || sourcePref === 'jd' || sourcePref === 'netease' || sourcePref === 'qq') {
      const gdSources = sourcePref === 'qq' ? ['tencent', 'netease'] : ['netease', 'tencent'];
      for (const src of gdSources) {
        tasks.push((async () => {
          try {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 2600);
            const gdSearchUrl = `https://music-api.gdstudio.xyz/api.php?types=search&source=${src}&name=${encodeURIComponent(baseKeyword)}&count=8&pages=1`;
            const gdRes = await fetch(gdSearchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
            clearTimeout(tid);
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
                    score: calcMusicMatchScore(title, artist, rawSong || baseKeyword, cleanArtistForQuery || rawArtist, false)
                  });
                }
              }
            }
          } catch (_) {}
        })());
      }
    }

    // 2. NetEase Cloud Music Official Search API
    if (sourcePref === 'all' || sourcePref === 'netease') {
      tasks.push((async () => {
        try {
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 2600);
          const neUrl = `https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${encodeURIComponent(baseKeyword)}&type=1&offset=0&total=true&limit=8`;
          const neRes = await fetch(neUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              'Referer': 'https://music.163.com/'
            },
            signal: ctrl.signal
          });
          clearTimeout(tid);
          if (neRes.ok) {
            const neData = await neRes.json();
            const songs = neData?.result?.songs || [];
            for (const s of songs.slice(0, 6)) {
              const title = String(s.name || '');
              const artist = Array.isArray(s.artists) ? s.artists.map((a) => a.name).join(' / ') : '';
              const albumName = String(s.album?.name || '');
              if (s.id) {
                candidates.push({
                  source: '网易云音乐',
                  sourceCode: 'netease_web',
                  trackId: String(s.id),
                  title,
                  artist,
                  url: '',
                  score: calcMusicMatchScore(`${title} ${albumName}`, artist, rawSong || baseKeyword, cleanArtistForQuery || rawArtist, false)
                });
              }
            }
          }
        } catch (_) {}
      })());
    }

    // 3. iTunes High-Availability Anime/Game Soundtrack Stream Search
    const searchItunesTerms = [queryKeyword];
    if (rawSong && cleanArtistForQuery && baseKeyword !== rawSong) {
      searchItunesTerms.push(`${rawSong} soundtrack instrumental`);
    } else if (rawSong && !hasInstHint) {
      searchItunesTerms.push(`${rawSong} instrumental`);
    }
    for (const term of searchItunesTerms.slice(0, 2)) {
      tasks.push((async () => {
        try {
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 2600);
          const itUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=8`;
          const itRes = await fetch(itUrl, { signal: ctrl.signal });
          clearTimeout(tid);
          if (itRes.ok) {
            const itData = await itRes.json();
            for (const item of (itData?.results || []).slice(0, 6)) {
              if (!item.previewUrl) continue;
              const title = String(item.trackName || '');
              const artist = String(item.artistName || '');
              const collection = String(item.collectionName || '');
              const genre = String(item.primaryGenreName || '');
              const combinedItunesMeta = `${title} ${collection} ${genre}`;
              const isLikelyOst = /soundtrack|ost|instrumental|score|piano|orchestra|bgm|游戏|原声|配乐/i.test(combinedItunesMeta);
              candidates.push({
                source: '动漫游戏原声台',
                sourceCode: 'itunes',
                trackId: String(item.trackId || ''),
                title,
                artist,
                url: `/api/music/stream?url=${encodeURIComponent(item.previewUrl)}`,
                rawStreamUrl: item.previewUrl,
                isPureInstrumental: isLikelyOst,
                score: calcMusicMatchScore(combinedItunesMeta, artist, rawSong || term, cleanArtistForQuery || rawArtist, true) + (isLikelyOst ? 35 : -20)
              });
            }
          }
        } catch (_) {}
      })());
    }

    await Promise.allSettled(tasks);

    // Sort by initial weight descending
    candidates.sort((a, b) => b.score - a.score);

    // Resolve URLs AND inspect lyrics for top candidates in parallel to strictly filter out vocal songs
    const topCandidates = candidates.slice(0, 8);
    await Promise.allSettled(topCandidates.map(async (cand) => {
      const lyricPromise = (cand.sourceCode === 'netease' || cand.sourceCode === 'netease_web' || cand.sourceCode === 'tencent')
        ? inspectTrackLyricsForVocals(cand.sourceCode, cand.trackId)
        : Promise.resolve({ isInstrumental: Boolean(cand.isPureInstrumental), hasVocals: false });

      const urlPromise = (async () => {
        if (!cand.url && cand.trackId) {
          if (cand.sourceCode === 'netease' || cand.sourceCode === 'tencent') {
            try {
              const ctrl = new AbortController();
              const tid = setTimeout(() => ctrl.abort(), 2200);
              const uRes = await fetch(`https://music-api.gdstudio.xyz/api.php?types=url&source=${cand.sourceCode}&id=${encodeURIComponent(cand.trackId)}&br=320`, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: ctrl.signal
              });
              clearTimeout(tid);
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
      })();

      const [lyricRes] = await Promise.all([lyricPromise, urlPromise]);
      if (lyricRes) {
        if (lyricRes.hasVocals) {
          cand.hasVocals = true;
          cand.isPureInstrumental = false;
          cand.score -= 600;
        } else if (lyricRes.isInstrumental) {
          cand.isPureInstrumental = true;
          cand.hasVocals = false;
          cand.score += 95;
        }
      }
    }));

    const playable = candidates.filter((c) => Boolean(c.url) && !c.hasVocals);
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

// ==================== 线上剧本工坊 (按素材指纹增量去重上传、在线流式阅读、覆盖更新与追更下载) ====================
const WORKSHOP_DIR = path.join(__dirname, '.workshop-store');
const WORKSHOP_ASSETS_DIR = path.join(WORKSHOP_DIR, 'assets');
const WORKSHOP_INDEX_FILE = path.join(WORKSHOP_DIR, 'workshop-index.json');
if (!fs.existsSync(WORKSHOP_DIR)) {
  fs.mkdirSync(WORKSHOP_DIR, { recursive: true });
}
if (!fs.existsSync(WORKSHOP_ASSETS_DIR)) {
  fs.mkdirSync(WORKSHOP_ASSETS_DIR, { recursive: true });
}

function sanitizeAssetHash(rawHash) {
  return String(rawHash || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function computeServerDataUrlHash(dataUrl) {
  return 'h_' + crypto.createHash('sha1').update(String(dataUrl || '')).digest('hex');
}

function getWorkshopAssetFilePath(hash) {
  const safe = sanitizeAssetHash(hash);
  if (!safe) return '';
  return path.join(WORKSHOP_ASSETS_DIR, `${safe}.json`);
}

function hasWorkshopAssetOnDisk(hash) {
  const fp = getWorkshopAssetFilePath(hash);
  return Boolean(fp && fs.existsSync(fp));
}

function saveWorkshopAssetToDisk(hash, dataUrl) {
  const safeHash = sanitizeAssetHash(hash) || computeServerDataUrlHash(dataUrl);
  const fp = getWorkshopAssetFilePath(safeHash);
  if (!fp) return null;
  if (fs.existsSync(fp)) {
    try {
      const stat = fs.statSync(fp);
      return { hash: safeHash, url: `/api/workshop/asset/${safeHash}`, sizeBytes: stat.size };
    } catch (_) {}
  }
  const str = String(dataUrl || '');
  const commaIdx = str.indexOf(',');
  if (!str.startsWith('data:') || commaIdx === -1) return null;
  const header = str.slice(0, commaIdx);
  const base64 = str.slice(commaIdx + 1);
  const mimeMatch = header.match(/^data:([^;]+)/i);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const sizeBytes = Math.floor((base64.length * 3) / 4);
  const record = { hash: safeHash, mime, base64, sizeBytes, updatedAt: Date.now() };
  fs.writeFileSync(fp, JSON.stringify(record), 'utf-8');
  return { hash: safeHash, url: `/api/workshop/asset/${safeHash}`, sizeBytes };
}

function extractInlineDataUrlsInObject(obj, collectedHashesSet) {
  if (!obj) return obj;
  if (typeof obj === 'string') {
    if (obj.startsWith('data:') && !obj.startsWith('data:image/svg+xml') && obj.length > 256) {
      const saved = saveWorkshopAssetToDisk('', obj);
      if (saved) {
        if (collectedHashesSet) collectedHashesSet.add(saved.hash);
        return saved.url;
      }
    } else if (obj.startsWith('/api/workshop/asset/')) {
      const h = sanitizeAssetHash(obj.slice('/api/workshop/asset/'.length).split('?')[0]);
      if (h && collectedHashesSet) collectedHashesSet.add(h);
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      obj[i] = extractInlineDataUrlsInObject(obj[i], collectedHashesSet);
    }
    return obj;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      obj[k] = extractInlineDataUrlsInObject(obj[k], collectedHashesSet);
    }
    return obj;
  }
  return obj;
}

function collectWorkshopAssetHashesInObject(obj, setOut) {
  if (!obj) return;
  if (typeof obj === 'string') {
    const idx = obj.indexOf('/api/workshop/asset/');
    if (idx !== -1) {
      const h = sanitizeAssetHash(obj.slice(idx + '/api/workshop/asset/'.length).split('?')[0]);
      if (h) setOut.add(h);
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((it) => collectWorkshopAssetHashesInObject(it, setOut));
    return;
  }
  if (typeof obj === 'object') {
    Object.values(obj).forEach((v) => collectWorkshopAssetHashesInObject(v, setOut));
  }
}

function computeTotalSizeOfHashes(hashSet) {
  let total = 0;
  for (const h of hashSet) {
    const fp = getWorkshopAssetFilePath(h);
    if (fp && fs.existsSync(fp)) {
      try {
        const st = fs.statSync(fp);
        total += Math.round(st.size * 0.75);
      } catch (_) {}
    }
  }
  return total;
}

function cleanupOrphanedWorkshopAssets() {
  try {
    const indexList = readWorkshopIndex();
    const activeHashes = new Set();
    for (const item of indexList) {
      if (!item || !item.id) continue;
      const proj = readWorkshopProjectData(item.id);
      if (proj) {
        collectWorkshopAssetHashesInObject(proj, activeHashes);
      }
    }
    if (activeHashes.size === 0 && indexList.length > 0) return;
    const files = fs.readdirSync(WORKSHOP_ASSETS_DIR);
    for (const fn of files) {
      if (!fn.endsWith('.json')) continue;
      const h = fn.slice(0, -5);
      if (!activeHashes.has(h)) {
        try {
          fs.unlinkSync(path.join(WORKSHOP_ASSETS_DIR, fn));
        } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('[Workshop] Cleanup orphaned assets error:', err.message);
  }
}

function readWorkshopIndex() {
  try {
    if (!fs.existsSync(WORKSHOP_INDEX_FILE)) return [];
    const raw = fs.readFileSync(WORKSHOP_INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[Workshop] Read index error:', err.message);
    return [];
  }
}

function writeWorkshopIndex(list) {
  try {
    fs.writeFileSync(WORKSHOP_INDEX_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Workshop] Write index error:', err.message);
  }
}

function readWorkshopProjectData(projectId) {
  const safeId = String(projectId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const projFile = path.join(WORKSHOP_DIR, `${safeId}.json`);
  if (!fs.existsSync(projFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(projFile, 'utf-8'));
  } catch (err) {
    return null;
  }
}

function writeWorkshopProjectData(projectId, data) {
  const safeId = String(projectId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const projFile = path.join(WORKSHOP_DIR, `${safeId}.json`);
  fs.writeFileSync(projFile, JSON.stringify(data), 'utf-8');
}

app.post('/api/workshop/check-assets', (req, res) => {
  try {
    const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes : [];
    const existing = [];
    const missing = [];
    for (const rawH of hashes) {
      const h = sanitizeAssetHash(rawH);
      if (!h) continue;
      if (hasWorkshopAssetOnDisk(h)) {
        existing.push(h);
      } else {
        missing.push(h);
      }
    }
    res.json({ ok: true, existing, missing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workshop/upload-asset', (req, res) => {
  try {
    const { hash, dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string') {
      return res.status(400).json({ error: '缺少有效素材数据' });
    }
    const saved = saveWorkshopAssetToDisk(hash, dataUrl);
    if (!saved) {
      return res.status(400).json({ error: '素材格式无效' });
    }
    res.json({ ok: true, hash: saved.hash, url: saved.url, sizeBytes: saved.sizeBytes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workshop/upload-assets-batch', (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const savedHashes = [];
    let totalBytes = 0;
    for (const item of items) {
      if (!item || !item.dataUrl || typeof item.dataUrl !== 'string') continue;
      const saved = saveWorkshopAssetToDisk(item.hash, item.dataUrl);
      if (saved) {
        savedHashes.push(saved.hash);
        totalBytes += Number(saved.sizeBytes || 0);
      }
    }
    res.json({ ok: true, count: savedHashes.length, hashes: savedHashes, sizeBytes: totalBytes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workshop/get-assets-batch', (req, res) => {
  try {
    const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes : [];
    const assets = {};
    for (const rawH of hashes) {
      const safeHash = sanitizeAssetHash(rawH);
      if (!safeHash) continue;
      const fp = getWorkshopAssetFilePath(safeHash);
      if (!fp || !fs.existsSync(fp)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        if (raw && raw.base64) {
          assets[safeHash] = `data:${raw.mime || 'application/octet-stream'};base64,${raw.base64}`;
        }
      } catch (_) {}
    }
    res.json({ ok: true, assets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workshop/asset/:hash', (req, res) => {
  try {
    const safeHash = sanitizeAssetHash(req.params.hash);
    const fp = getWorkshopAssetFilePath(safeHash);
    if (!fp || !fs.existsSync(fp)) {
      return res.status(404).json({ error: '素材不存在' });
    }
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (req.query.format === 'dataurl') {
      return res.json({
        ok: true,
        hash: safeHash,
        mime: raw.mime || 'application/octet-stream',
        dataUrl: `data:${raw.mime || 'application/octet-stream'};base64,${raw.base64 || ''}`
      });
    }
    const buf = Buffer.from(raw.base64 || '', 'base64');
    res.setHeader('Content-Type', raw.mime || 'application/octet-stream');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workshop/list', (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const list = readWorkshopIndex();
    const filtered = q
      ? list.filter((item) =>
          String(item.title || '').toLowerCase().includes(q) ||
          String(item.author || '').toLowerCase().includes(q) ||
          String(item.desc || '').toLowerCase().includes(q)
        )
      : list;
    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ ok: true, items: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workshop/upload-chapter', (req, res) => {
  try {
    const {
      projectId,
      title,
      author,
      desc,
      avatarUrl,
      uiTheme,
      globalScenes,
      extractedSpeakers,
      characters,
      bgmTracks,
      subGroups,
      assetPackIndex,
      mode,
      chapters,
      ttsByChapter,
      chapterIndex,
      chapterData,
      chapterTtsList,
      payloadSizeBytes
    } = req.body || {};

    if (!projectId || (!chapterData && (!Array.isArray(chapters) || chapters.length === 0))) {
      return res.status(400).json({ error: '缺少剧本ID或章节数据' });
    }

    const now = Date.now();
    let storedProj = readWorkshopProjectData(projectId);
    if (!storedProj) {
      storedProj = {
        id: projectId,
        title: title || '未命名跑团剧本',
        author: author || '匿名KP',
        desc: desc || '',
        avatarUrl: '',
        uiTheme: uiTheme || 'default',
        globalScenes: [],
        extractedSpeakers: [],
        characters: [],
        bgmTracks: [],
        subGroups: [],
        assetPackIndex: {},
        chapters: [],
        ttsByChapter: {},
        createdAt: now,
        updatedAt: now
      };
    }

    const assetHashes = new Set();
    storedProj.title = title || storedProj.title || '未命名跑团剧本';
    storedProj.author = author || storedProj.author || '匿名KP';
    if (typeof desc === 'string') storedProj.desc = desc;
    if (typeof avatarUrl === 'string' && avatarUrl) {
      storedProj.avatarUrl = extractInlineDataUrlsInObject(avatarUrl, assetHashes);
    }
    if (uiTheme) storedProj.uiTheme = uiTheme;
    if (Array.isArray(globalScenes) && globalScenes.length > 0) {
      storedProj.globalScenes = extractInlineDataUrlsInObject(globalScenes, assetHashes);
    }
    if (Array.isArray(extractedSpeakers) && extractedSpeakers.length > 0) {
      storedProj.extractedSpeakers = extractedSpeakers;
    }
    if (Array.isArray(subGroups) && subGroups.length > 0) {
      storedProj.subGroups = extractInlineDataUrlsInObject(subGroups, assetHashes);
    }
    if (assetPackIndex && typeof assetPackIndex === 'object') {
      storedProj.assetPackIndex = { ...(storedProj.assetPackIndex || {}), ...assetPackIndex };
    }
    if (Array.isArray(characters) && characters.length > 0) {
      const cleanedChars = extractInlineDataUrlsInObject(characters, assetHashes);
      const charMap = new Map();
      (storedProj.characters || []).forEach((c) => {
        if (c && c.id) charMap.set(c.id, c);
      });
      cleanedChars.forEach((c) => {
        if (c && c.id) charMap.set(c.id, c);
      });
      storedProj.characters = Array.from(charMap.values());
    }
    if (Array.isArray(bgmTracks) && bgmTracks.length > 0) {
      const bgmMap = new Map();
      (storedProj.bgmTracks || []).forEach((b) => {
        if (b && (b.id || b.name)) bgmMap.set(b.id || b.name, b);
      });
      bgmTracks.forEach((b) => {
        if (b && (b.id || b.name)) bgmMap.set(b.id || b.name, b);
      });
      storedProj.bgmTracks = Array.from(bgmMap.values());
    }

    if (!Array.isArray(storedProj.chapters)) storedProj.chapters = [];
    if (!storedProj.ttsByChapter || typeof storedProj.ttsByChapter !== 'object') {
      storedProj.ttsByChapter = {};
    }

    let isOverwrite = false;
    let latestVersion = 1;

    if (mode === 'full' && Array.isArray(chapters) && chapters.length > 0) {
      const cleanedChaps = extractInlineDataUrlsInObject(chapters, assetHashes);
      isOverwrite = storedProj.chapters.length > 0;
      storedProj.chapters = cleanedChaps.map((ch, idx) => {
        const orderNum = Number(ch.order ?? idx);
        const prev = (storedProj.chapters || []).find((oldC) => (ch.id && oldC.id === ch.id) || Number(oldC.order ?? -1) === orderNum);
        const ver = (Number(prev?.version) || 0) + 1;
        latestVersion = Math.max(latestVersion, ver);
        return {
          ...ch,
          order: orderNum,
          version: ver,
          updatedAt: now
        };
      });
      storedProj.chapters.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
      if (ttsByChapter && typeof ttsByChapter === 'object') {
        const cleanedTtsMap = extractInlineDataUrlsInObject(ttsByChapter, assetHashes);
        Object.entries(cleanedTtsMap).forEach(([k, v]) => {
          if (Array.isArray(v)) storedProj.ttsByChapter[k] = v;
        });
      }
    } else if (chapterData) {
      const cleanedChap = extractInlineDataUrlsInObject(chapterData, assetHashes);
      const targetChapOrder = Number(chapterIndex ?? cleanedChap.order ?? 0);
      const prevChap = storedProj.chapters.find((c) => Number(c.order) === targetChapOrder || c.id === cleanedChap.id);
      latestVersion = ((Number(prevChap?.version)) || 0) + 1;
      const chapRecord = {
        ...cleanedChap,
        order: targetChapOrder,
        version: latestVersion,
        updatedAt: now
      };

      const existingIdx = storedProj.chapters.findIndex(
        (c) => (cleanedChap.id && c.id === cleanedChap.id) || Number(c.order) === targetChapOrder
      );
      isOverwrite = existingIdx >= 0;
      if (existingIdx >= 0) {
        storedProj.chapters[existingIdx] = chapRecord;
      } else {
        storedProj.chapters.push(chapRecord);
        storedProj.chapters.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
      }

      const ttsKey = String(chapRecord.id || `chap_${targetChapOrder}`);
      if (Array.isArray(chapterTtsList)) {
        storedProj.ttsByChapter[ttsKey] = extractInlineDataUrlsInObject(chapterTtsList, assetHashes);
      }
    }

    collectWorkshopAssetHashesInObject(storedProj, assetHashes);
    const computedAssetBytes = computeTotalSizeOfHashes(assetHashes);
    storedProj.updatedAt = now;
    storedProj.sizeBytes = Math.max(computedAssetBytes, Number(payloadSizeBytes) || 0, Number(storedProj.sizeBytes) || 0);
    writeWorkshopProjectData(projectId, storedProj);

    const indexList = readWorkshopIndex();
    const summaryItem = {
      id: storedProj.id,
      title: storedProj.title,
      author: storedProj.author,
      desc: storedProj.desc || '',
      avatarUrl: storedProj.avatarUrl || '',
      uiTheme: storedProj.uiTheme || 'default',
      sizeBytes: storedProj.sizeBytes || 0,
      charCount: Array.isArray(storedProj.characters) ? storedProj.characters.length : 0,
      chapterCount: storedProj.chapters.length,
      chaptersMeta: storedProj.chapters.map((c, idx) => ({
        id: c.id || `chap_${idx}`,
        order: Number(c.order ?? idx),
        title: c.title || `第${idx + 1}章`,
        lineCount: Array.isArray(c.scriptLines) ? c.scriptLines.length : 0,
        cgCount: Array.isArray(c.cgNodes) ? c.cgNodes.filter((g) => g && g.imageUrl).length : 0,
        clueCount: Array.isArray(c.clueNodes) ? c.clueNodes.length : 0,
        version: c.version || 1,
        updatedAt: c.updatedAt || now
      })),
      updatedAt: now
    };
    const sumIdx = indexList.findIndex((x) => x.id === storedProj.id);
    if (sumIdx >= 0) {
      indexList[sumIdx] = summaryItem;
    } else {
      indexList.unshift(summaryItem);
    }
    writeWorkshopIndex(indexList);
    cleanupOrphanedWorkshopAssets();

    res.json({
      ok: true,
      mode: mode || 'single',
      isOverwrite,
      chapterVersion: latestVersion,
      chapterCount: storedProj.chapters.length,
      summary: summaryItem
    });
  } catch (err) {
    console.error('[Workshop Upload Error]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workshop/project/:id', (req, res) => {
  try {
    const projectId = req.params.id;
    const storedProj = readWorkshopProjectData(projectId);
    if (!storedProj) {
      return res.status(404).json({ error: '工坊中未找到该剧本' });
    }
    res.json({ ok: true, project: storedProj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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



