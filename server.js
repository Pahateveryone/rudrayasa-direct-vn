const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const ROOT = __dirname;
const TEMP_DIR = path.join(ROOT, 'temp');

const MONGODB_URI = process.env.MONGODB_URI || '';
const APP_USER = process.env.APP_USER || 'rudrayasa';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_NAME = process.env.SESSION_NAME || 'rudrayasa-main';
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

if (!MONGODB_URI) {
  console.error('FATAL: MONGODB_URI belum diset.');
  process.exit(1);
}
if (!APP_PASSWORD) {
  console.error('FATAL: APP_PASSWORD belum diset.');
  process.exit(1);
}

fs.mkdirSync(TEMP_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Basic realm="Rudrayasa Private"');
  return res.status(401).send('Authentication required.');
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

app.use((req, res, next) => {
  if (req.path === '/healthz') return next();

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return unauthorized(res);

  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return unauthorized(res);

    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);

    if (!safeEqual(user, APP_USER) || !safeEqual(pass, APP_PASSWORD)) {
      return unauthorized(res);
    }

    next();
  } catch (_) {
    return unauthorized(res);
  }
});

app.use(express.static(path.join(ROOT, 'public')));

let waClient = null;
let waState = {
  ready: false,
  authenticated: false,
  remoteSaved: false,
  qrDataUrl: null,
  pairingCode: null,
  status: 'Menghubungkan MongoDB...',
  account: null
};

const prepared = new Map();

function normalizeNumber(raw) {
  let n = String(raw || '').replace(/[^\d+]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  if (n.startsWith('0')) n = '62' + n.slice(1);

  if (!/^\d{8,18}$/.test(n)) {
    throw new Error('Nomor tidak valid. Contoh: 628123456789.');
  }
  return n;
}

async function initializeWhatsApp() {
  waState.status = 'Menghubungkan MongoDB Atlas...';

  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 20000
  });

  waState.status = 'MongoDB terhubung. Memulai WhatsApp...';

  const store = new MongoStore({ mongoose });

  waClient = new Client({
    authStrategy: new RemoteAuth({
      store,
      clientId: SESSION_NAME,
      backupSyncIntervalMs: 60000,
      rmMaxRetries: 3
    }),
    puppeteer: {
      headless: true,
      executablePath: CHROME_PATH,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,BackForwardCache,AcceptCHFrame'
      ]
    }
  });

  waClient.on('qr', async (qr) => {
    waState.ready = false;
    waState.authenticated = false;
    waState.status = 'WhatsApp belum ditautkan.';
    try {
      waState.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    } catch (_) {}
  });

  waClient.on('code', (code) => {
    waState.pairingCode = code;
  });

  waClient.on('authenticated', () => {
    waState.authenticated = true;
    waState.pairingCode = null;
    waState.status = 'WhatsApp authenticated. Menunggu READY...';
  });

  waClient.on('remote_session_saved', () => {
    waState.remoteSaved = true;
    if (waState.ready) waState.status = 'WhatsApp READY — session tersimpan di MongoDB.';
    console.log('[WA] Remote session tersimpan di MongoDB.');
  });

  waClient.on('ready', () => {
    waState.ready = true;
    waState.authenticated = true;
    waState.qrDataUrl = null;
    waState.pairingCode = null;
    waState.status = 'WhatsApp READY.';
    try {
      waState.account = waClient.info?.wid?._serialized || null;
    } catch (_) {}
    console.log('[WA] READY', waState.account || '');
  });

  waClient.on('auth_failure', msg => {
    waState.ready = false;
    waState.authenticated = false;
    waState.status = 'Authentication gagal: ' + msg;
    console.error('[WA] auth_failure', msg);
  });

  waClient.on('disconnected', reason => {
    waState.ready = false;
    waState.status = 'WhatsApp terputus: ' + reason;
    console.error('[WA] disconnected', reason);
  });

  await waClient.initialize();
}

initializeWhatsApp().catch(err => {
  waState.ready = false;
  waState.status = 'Startup gagal: ' + (err.message || String(err));
  console.error(err);
});

const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 75 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'
    ]);
    cb(null, allowed.has(path.extname(file.originalname).toLowerCase()));
  }
});

function runFfmpeg(input, output) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', input,
      '-vn',
      '-map_metadata', '-1',
      '-ac', '1',
      '-ar', '48000',
      '-c:a', 'libopus',
      '-b:a', '48k',
      '-vbr', 'on',
      '-compression_level', '3',
      '-application', 'voip',
      '-frame_duration', '20',
      '-f', 'ogg',
      output
    ];

    const p = spawn('ffmpeg', args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let err = '';

    p.stderr.on('data', b => {
      err += b.toString();
      if (err.length > 6000) err = err.slice(-6000);
    });

    p.on('error', e => {
      reject(new Error('FFmpeg tidak dapat dijalankan: ' + e.message));
    });

    p.on('close', code => {
      if (code === 0 && fs.existsSync(output)) resolve();
      else reject(new Error(err || `FFmpeg exit code ${code}`));
    });
  });
}

function deleteJob(id) {
  const job = prepared.get(id);
  if (!job) return;

  try { fs.unlinkSync(job.path); } catch (_) {}
  prepared.delete(id);
}

setInterval(() => {
  const cutoff = Date.now() - 20 * 60 * 1000;
  for (const [id, job] of prepared.entries()) {
    if (job.createdAt < cutoff) deleteJob(id);
  }
}, 5 * 60 * 1000).unref();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/status', (_req, res) => {
  res.json(waState);
});

app.post('/api/pairing-code', async (req, res) => {
  try {
    if (!waClient) throw new Error('WhatsApp client belum siap.');

    if (waState.ready) {
      return res.json({ ok: true, alreadyReady: true });
    }

    const number = normalizeNumber(req.body?.number);
    const code = await waClient.requestPairingCode(number, true, 180000);
    waState.pairingCode = code;

    res.json({ ok: true, code });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

app.post('/api/prepare', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: 'File audio tidak diterima atau format tidak didukung.'
    });
  }

  const id = crypto.randomUUID();
  const outputPath = path.join(TEMP_DIR, `${id}.ogg`);

  try {
    const started = Date.now();

    await runFfmpeg(req.file.path, outputPath);

    const stat = fs.statSync(outputPath);

    prepared.set(id, {
      path: outputPath,
      originalName: req.file.originalname,
      createdAt: Date.now()
    });

    res.json({
      ok: true,
      jobId: id,
      originalName: req.file.originalname,
      elapsedMs: Date.now() - started,
      size: stat.size,
      format: 'OGG / Opus / 48 kHz / mono'
    });
  } catch (err) {
    try { fs.unlinkSync(outputPath); } catch (_) {}
    res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
  }
});

app.post('/api/send', async (req, res) => {
  if (!waState.ready || !waClient) {
    return res.status(409).json({
      ok: false,
      error: 'WhatsApp belum READY.'
    });
  }

  const jobId = req.body?.jobId;
  const job = prepared.get(jobId);

  if (!job || !fs.existsSync(job.path)) {
    return res.status(404).json({
      ok: false,
      error: 'Audio READY tidak ditemukan. Pilih file lagi.'
    });
  }

  try {
    const number = normalizeNumber(req.body?.number);
    const numberId = await waClient.getNumberId(number);

    if (!numberId) {
      throw new Error('Nomor target tidak terdaftar di WhatsApp.');
    }

    const media = MessageMedia.fromFilePath(job.path);

    const message = await waClient.sendMessage(
      numberId._serialized,
      media,
      {
        sendAudioAsVoice: true,
        sendSeen: false,
        waitUntilMsgSent: true
      }
    );

    deleteJob(jobId);

    res.json({
      ok: true,
      target: number,
      messageId: message?.id?._serialized || null
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

app.delete('/api/job/:id', (req, res) => {
  deleteJob(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  console.log(`[APP] http://${HOST}:${PORT}`);
  console.log(`[APP] Chromium: ${CHROME_PATH}`);
});
