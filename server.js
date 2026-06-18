const express    = require('express');
const cors       = require('cors');
const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');
    next();
});

// ── State ──
const downloads = {};

// ── Progress regex ──
// [download]  45.3% of   25.00MiB at    1.23MiB/s ETA 00:13
const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+([\d.]+)([KMGTkmgt]i?B)\s+at\s+([\d.]+)([KMGTkmgt]i?B)\/s/;

function toMB(value, unit) {
    const u = unit.toUpperCase();
    if (u.includes('G')) return value * 1024;
    if (u.includes('M')) return value;
    if (u.includes('K')) return value / 1024;
    return value / (1024 * 1024);
}

const SUPPORTED_DOMAINS = {
    youtube:   ['youtube.com', 'youtu.be', 'www.youtube.com'],
    instagram: ['instagram.com', 'www.instagram.com'],
    facebook:  ['facebook.com', 'www.facebook.com', 'fb.watch', 'fb.com']
};

function detectPlatform(url) {
    for (const [platform, domains] of Object.entries(SUPPORTED_DOMAINS)) {
        if (domains.some(d => url.includes(d))) return platform;
    }
    return null;
}

// ── Routes ──
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── Video Info ──
app.post('/api/info', (req, res) => {
    const url = (req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'URL dalo pehle!' });

    const platform = detectPlatform(url);
    if (!platform) return res.status(400).json({ error: 'Sirf YouTube, Instagram aur Facebook URLs support hote hain.' });

    const proc = spawn('yt-dlp', ['--dump-json', '--no-playlist', '--quiet', url]);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', code => {
        if (code !== 0) return res.status(500).json({ error: stderr || 'Video info fetch karne mein error aaya' });
        try {
            const info    = JSON.parse(stdout);
            const seen    = new Set();
            const formats = [];
            for (const f of (info.formats || [])) {
                if (f.vcodec === 'none' || !f.height) continue;
                const label = `${f.height}p`;
                if (seen.has(label)) continue;
                seen.add(label);
                const sizeMb = f.filesize ? +(f.filesize / 1048576).toFixed(1) : (f.filesize_approx ? +(f.filesize_approx / 1048576).toFixed(1) : null);
                formats.push({ format_id: f.format_id, quality: label, height: f.height, ext: f.ext || 'mp4', size_mb: sizeMb });
            }
            formats.sort((a, b) => b.height - a.height);
            res.json({
                title:    info.title || 'Video',
                thumbnail: info.thumbnail || '',
                duration:  info.duration || 0,
                uploader:  info.uploader || '',
                formats,
                url,
                platform
            });
        } catch (e) {
            res.status(500).json({ error: 'Video parse karne mein problem aayi.' });
        }
    });

    setTimeout(() => { proc.kill(); res.status(500).json({ error: 'Request timeout ho gaya.' }); }, 30000);
});

// ── Start Download ──
app.post('/api/start-download', (req, res) => {
    const { url, format_id = 'best', type: dlType = 'video', title = 'Video', quality = '' } = req.body;
    if (!url) return res.status(400).json({ error: 'URL missing hai' });

    const dlId  = uuidv4().slice(0, 8);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));

    downloads[dlId] = {
        id: dlId, url, title, quality, status: 'starting',
        percent: 0, downloaded_mb: 0, total_mb: 0, speed_mb: 0,
        filepath: null, filename: null, error: null,
        started_at: Date.now()
    };

    res.json({ download_id: dlId });

    // Run download in background
    setImmediate(() => runDownload(dlId, url, format_id, dlType, tmpDir));
});

function runDownload(dlId, url, formatId, dlType, tmpDir) {
    const dl  = downloads[dlId];
    const out = path.join(tmpDir, '%(title)s.%(ext)s');

    let cmd, args;
    if (dlType === 'mp3') {
        args = ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
                '--no-playlist', '--newline', '-o', out, url];
    } else if (dlType === '3gp') {
        args = ['-f', 'worst[ext=3gp]/worst', '--no-playlist', '--newline',
                '--recode-video', '3gp', '-o', out, url];
    } else {
        args = ['-f', `${formatId}+bestaudio/${formatId}/best`,
                '--merge-output-format', 'mp4', '--no-playlist', '--newline',
                '-o', out, url];
    }

    const proc = spawn('yt-dlp', args);
    dl.status = 'downloading';

    let buf = '';
    proc.stdout.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
            const m = PROGRESS_RE.exec(line);
            if (m) {
                const pct      = parseFloat(m[1]);
                const totalMb  = toMB(parseFloat(m[2]), m[3]);
                const speedMb  = toMB(parseFloat(m[4]), m[5]);
                dl.percent       = +pct.toFixed(1);
                dl.total_mb      = +totalMb.toFixed(2);
                dl.downloaded_mb = +(totalMb * pct / 100).toFixed(2);
                dl.speed_mb      = +speedMb.toFixed(3);
            }
        }
    });

    proc.stderr.on('data', () => {});

    proc.on('close', code => {
        const files = fs.existsSync(tmpDir)
            ? fs.readdirSync(tmpDir).filter(f => !f.endsWith('.part'))
            : [];
        if (code === 0 && files.length > 0) {
            dl.status   = 'done';
            dl.percent  = 100;
            dl.filepath = path.join(tmpDir, files[0]);
            dl.filename = files[0];
        } else {
            dl.status = 'error';
            dl.error  = 'Download fail hua. Dobara try karo.';
        }
    });
}

// ── SSE Progress ──
app.get('/api/progress/:dlId', (req, res) => {
    const { dlId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = () => {
        const dl = downloads[dlId];
        if (!dl) { res.write(`data: ${JSON.stringify({ error: 'Not found' })}\n\n`); return res.end(); }
        res.write(`data: ${JSON.stringify({
            status: dl.status, percent: dl.percent,
            downloaded_mb: dl.downloaded_mb, total_mb: dl.total_mb,
            speed_mb: dl.speed_mb, title: dl.title, quality: dl.quality,
            filename: dl.filename, error: dl.error
        })}\n\n`);
        if (dl.status === 'done' || dl.status === 'error') { clearInterval(timer); return res.end(); }
    };

    send();
    const timer = setInterval(send, 500);
    req.on('close', () => clearInterval(timer));
});

// ── Get File ──
app.get('/api/get-file/:dlId', (req, res) => {
    const dl = downloads[req.params.dlId];
    if (!dl || dl.status !== 'done' || !dl.filepath)
        return res.status(404).json({ error: 'File ready nahi hai' });

    const ext  = path.extname(dl.filename).toLowerCase();
    const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.3gp' ? 'video/3gpp' : 'video/mp4';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(dl.filename)}"`);
    res.sendFile(dl.filepath);
});

app.listen(PORT, '0.0.0.0', () => console.log(`VidSave running on port ${PORT}`));
