// ── State ──
const currentData = { youtube:null, instagram:null, facebook:null };
const selectedFormats = { youtube:null, instagram:null, facebook:null };
const platformInputs = { youtube:'yt-url', instagram:'ig-url', facebook:'fb-url' };
const platformResults = { youtube:'yt-result', instagram:'ig-result', facebook:'fb-result' };
let queue = [];
let activeDownloads = {};
let panelOpen = false;
const speedHistory = {}; // dlId → [speed values]
const MAX_SPEED_POINTS = 40;

// ── Speed Graph SVG builder ──
function buildSpeedGraph(dlId, currentSpeed) {
    if (!speedHistory[dlId]) speedHistory[dlId] = [];
    if (currentSpeed > 0.001) speedHistory[dlId].push(currentSpeed);
    if (speedHistory[dlId].length > MAX_SPEED_POINTS)
        speedHistory[dlId] = speedHistory[dlId].slice(-MAX_SPEED_POINTS);

    const pts = speedHistory[dlId];
    if (pts.length < 2) return '';

    const W = 300, H = 52;
    const maxVal = Math.max(...pts) * 1.15 || 1;
    const step = W / (MAX_SPEED_POINTS - 1);

    // Build smooth path points
    const coords = pts.map((v, i) => {
        const x = (MAX_SPEED_POINTS - pts.length + i) * step;
        const y = H - (v / maxVal) * (H - 6) - 2;
        return [x, y];
    });

    // Smooth bezier path
    let d = `M ${coords[0][0]} ${coords[0][1]}`;
    for (let i = 1; i < coords.length; i++) {
        const [x0, y0] = coords[i - 1];
        const [x1, y1] = coords[i];
        const cx = (x0 + x1) / 2;
        d += ` C ${cx} ${y0} ${cx} ${y1} ${x1} ${y1}`;
    }

    // Fill area under curve
    const lastX = coords[coords.length - 1][0];
    const firstX = coords[0][0];
    const fillD = `${d} L ${lastX} ${H} L ${firstX} ${H} Z`;

    // Peak speed label
    const peakSpeed = Math.max(...pts);
    const avgSpeed  = pts.reduce((a,b) => a+b, 0) / pts.length;

    return `<div class="speed-graph-wrap">
        <div class="speed-graph-labels">
            <span class="sg-label peak">▲ Peak: ${peakSpeed.toFixed(2)} MB/s</span>
            <span class="sg-label avg">Avg: ${avgSpeed.toFixed(2)} MB/s</span>
        </div>
        <svg class="speed-graph-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
            <defs>
                <linearGradient id="sgGrad${dlId}" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#a855f7" stop-opacity="0.45"/>
                    <stop offset="100%" stop-color="#a855f7" stop-opacity="0.03"/>
                </linearGradient>
            </defs>
            <path d="${fillD}" fill="url(#sgGrad${dlId})"/>
            <path d="${d}" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    </div>`;
}

// ── Tab switch ──
function switchTab(platform) {
    document.querySelectorAll('.platform-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById(`section-${platform}`).classList.add('active');
    document.getElementById(`nav-${platform}`).classList.add('active');
    if (platform === 'queue') renderQueueTab();
}

// ── Downloads Panel ──
function toggleDownloadsPanel() {
    panelOpen = !panelOpen;
    document.getElementById('downloads-panel').classList.toggle('open', panelOpen);
    document.getElementById('panel-overlay').classList.toggle('show', panelOpen);
    document.getElementById('menu-btn').classList.toggle('open', panelOpen);
    if (panelOpen) renderDownloadsPanel();
}

// ── Paste ──
async function pasteUrl(id) {
    try {
        const t = await navigator.clipboard.readText();
        document.getElementById(id).value = t;
        showToast('✅ Link paste ho gaya!');
    } catch {
        document.getElementById(id).focus();
        showToast('📋 Input tap karke paste karo');
    }
}

// ── Toast ──
function showToast(msg, dur=2500) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), dur);
}

// ── Fetch Info ──
async function fetchInfo(platform) {
    const url = document.getElementById(platformInputs[platform]).value.trim();
    if (!url) { showToast('⚠️ Pehle link paste karo!'); return; }
    if (!url.startsWith('http')) { showToast('❌ Valid URL daalo'); return; }

    const rd = document.getElementById(platformResults[platform]);
    rd.innerHTML = `<div class="fetching-card">
        <p>🔍 Video info fetch ho raha hai...</p>
        <div class="prog-bar-wrap"><div class="prog-bar-fill indeterminate"></div></div>
    </div>`;

    try {
        const res = await fetch('/api/info', { method:'POST',
            headers:{'Content-Type':'application/json'}, body:JSON.stringify({url}) });
        const data = await res.json();
        if (!res.ok) { renderError(platform, data.error || 'Kuch galat hua'); return; }
        currentData[platform] = data;
        selectedFormats[platform] = data.formats.length > 0 ? data.formats[0].format_id : null;
        renderResult(platform, data);
    } catch { renderError(platform, 'Network error. Internet check karo.'); }
}

// ── Render Result ──
function renderResult(platform, data) {
    const rd = document.getElementById(platformResults[platform]);
    const hasFormats = data.formats && data.formats.length > 0;
    const dur = formatDuration(data.duration);

    const qualBtns = hasFormats
        ? data.formats.map((f,i) => `
            <button class="quality-btn ${i===0?'selected':''}"
                    onclick="selectQuality('${platform}','${f.format_id}',this)">
                <span class="quality-label">${f.quality}</span>
                <span class="quality-size">${f.size_mb ? f.size_mb+' MB' : f.ext.toUpperCase()}</span>
            </button>`).join('')
        : `<p style="color:var(--txt2);font-size:12px;grid-column:span 3;text-align:center;padding:6px">Koi video quality nahi mili</p>`;

    rd.innerHTML = `
    <div class="video-card">
        ${data.thumbnail
          ? `<img class="video-thumbnail" src="${data.thumbnail}" alt="thumb"
               onerror="this.parentNode.innerHTML='<div class=\\"thumb-placeholder\\">🎬</div>'">`
          : '<div class="thumb-placeholder">🎬</div>'}
        <div class="video-details">
            <div class="video-title">${esc(data.title)}</div>
            <div class="video-meta">
                ${data.uploader ? `<span class="meta-badge">👤 ${esc(data.uploader)}</span>` : ''}
                ${dur ? `<span class="meta-badge">⏱ ${dur}</span>` : ''}
                ${hasFormats ? `<span class="meta-badge">🎞 ${data.formats.length} quality</span>` : ''}
            </div>
        </div>
    </div>

    ${hasFormats ? `
    <div class="quality-card">
        <div class="card-title">📹 Video Quality Chuno</div>
        <div class="quality-grid">${qualBtns}</div>
    </div>` : ''}

    <div class="download-card">
        <div class="card-title">⬇️ Download Format Chuno</div>
        <div class="dl-btn-grid-3">
            ${hasFormats ? `
            <button class="dl-type-btn btn-video" onclick="startDownload('${platform}','video')">
                <span class="btn-icon-lrg">🎬</span>
                <span class="btn-label">Video</span>
                <span class="btn-sub">MP4 • HD</span>
            </button>` : ''}
            <button class="dl-type-btn btn-mp3" onclick="startDownload('${platform}','mp3')">
                <span class="btn-icon-lrg">🎵</span>
                <span class="btn-label">MP3</span>
                <span class="btn-sub">Audio Only</span>
            </button>
            <button class="dl-type-btn btn-3gp" onclick="startDownload('${platform}','3gp')">
                <span class="btn-icon-lrg">📱</span>
                <span class="btn-label">3GP</span>
                <span class="btn-sub">Keypad</span>
            </button>
        </div>
        <div class="divider-label">— Queue mein add karo (baad mein download) —</div>
        <div class="dl-btn-grid-3">
            ${hasFormats ? `
            <button class="dl-type-btn btn-queue-v" onclick="addToQueue('${platform}','video')" style="padding:11px 5px">
                <span style="font-size:16px">🎬</span>
                <span style="font-size:10px;font-weight:800">Video</span>
            </button>` : ''}
            <button class="dl-type-btn btn-queue-m" onclick="addToQueue('${platform}','mp3')" style="padding:11px 5px">
                <span style="font-size:16px">🎵</span>
                <span style="font-size:10px;font-weight:800">MP3</span>
            </button>
            <button class="dl-type-btn btn-queue-3" onclick="addToQueue('${platform}','3gp')" style="padding:11px 5px">
                <span style="font-size:16px">📱</span>
                <span style="font-size:10px;font-weight:800">3GP</span>
            </button>
        </div>
    </div>
    <div id="prog-${platform}"></div>`;
}

// ── Quality select ──
function selectQuality(platform, fid, btn) {
    selectedFormats[platform] = fid;
    btn.closest('.quality-grid').querySelectorAll('.quality-btn')
       .forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

function getQualityLabel(platform) {
    const btn = document.querySelector(`#section-${platform} .quality-btn.selected`);
    return btn ? btn.querySelector('.quality-label').textContent : 'Best';
}

// ── Start Download ──
async function startDownload(platform, dlType) {
    const data = currentData[platform];
    if (!data) { showToast('⚠️ Pehle video info fetch karo!'); return; }

    const formatId = selectedFormats[platform] || 'best';
    const qualLabel = dlType === 'mp3' ? 'MP3' : dlType === '3gp' ? '3GP' : getQualityLabel(platform);

    showToast('▶️ Download shuru ho gaya...');
    const progDiv = document.getElementById(`prog-${platform}`);
    if (progDiv) showProgressCard(progDiv, null, 0, 0, 0, 0, 'starting', dlType);

    try {
        const res = await fetch('/api/start-download', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ url:data.url, format_id:formatId, type:dlType,
                                  title:data.title, quality:qualLabel })
        });
        const json = await res.json();
        if (!res.ok) { showToast('❌ '+(json.error||'Error')); return; }

        const dlId = json.download_id;
        activeDownloads[dlId] = { id:dlId, title:data.title, quality:qualLabel,
                                   status:'starting', percent:0,
                                   downloaded_mb:0, total_mb:0, speed_mb:0 };
        updateBadge();
        listenProgress(platform, dlId, dlType, progDiv);
        if (panelOpen) renderDownloadsPanel();
    } catch { showToast('❌ Download start karne mein error'); }
}

// ── SSE listener ──
function listenProgress(platform, dlId, dlType, progDiv) {
    const src = new EventSource(`/api/progress/${dlId}`);
    src.onmessage = e => {
        const d = JSON.parse(e.data);
        if (activeDownloads[dlId]) activeDownloads[dlId] = {...activeDownloads[dlId], ...d};
        updateBadge();
        if (progDiv) showProgressCard(progDiv, dlId, d.percent, d.downloaded_mb, d.total_mb, d.speed_mb, d.status, dlType, d.error);
        if (panelOpen) renderDownloadsPanel();
        if (d.status === 'done') {
            src.close();
            // Auto-download to phone immediately
            saveFile(dlId);
            // Clear progress card from page
            if (progDiv) progDiv.innerHTML = '';
            showToast('✅ Phone mein download ho raha hai!');
            updateBadge();
            if (panelOpen) renderDownloadsPanel();
            // Auto-remove from panel after 4 seconds
            setTimeout(() => {
                delete activeDownloads[dlId];
                delete speedHistory[dlId];
                updateBadge();
                if (panelOpen) renderDownloadsPanel();
            }, 4000);
        }
        if (d.status === 'error') { src.close(); showToast('❌ '+(d.error||'Download fail hua')); updateBadge(); }
    };
    src.onerror = () => { src.close(); if (activeDownloads[dlId]) activeDownloads[dlId].status='error'; updateBadge(); };
}

// ── Progress Card ──
function showProgressCard(container, dlId, pct, dlMb, totalMb, speedMb, status, dlType, errMsg) {
    const indeterminate = status==='starting' || (pct===0 && status==='downloading');
    const pctStr = indeterminate ? '...' : Math.round(pct)+'%';
    const sizeStr = totalMb > 0.01
        ? `${dlMb.toFixed(2)} / ${totalMb.toFixed(2)} MB`
        : (dlMb > 0 ? `${dlMb.toFixed(2)} MB` : '');
    const speedStr = speedMb > 0.001 ? `⚡ ${speedMb.toFixed(2)} MB/s` : '';
    const typeIcon = dlType==='mp3' ? '🎵' : dlType==='3gp' ? '📱' : '🎬';

    if (status === 'error') {
        container.innerHTML = `<div class="error-card">
            <div class="error-icon">⚠️</div>
            <div class="error-text">${esc(errMsg||'Download fail hua. Dobara try karo.')}</div>
        </div>`;
        return;
    }
    if (status === 'done') {
        container.innerHTML = `<div class="progress-card done-card">
            <div class="progress-label">✅ Download Complete — ${typeIcon} ${dlType?.toUpperCase()}</div>
            <div class="prog-bar-wrap">
                <div class="prog-bar-fill green" style="width:100%"></div>
            </div>
            <div class="prog-stats">
                <div class="prog-pct" style="color:var(--green)">100%</div>
                <div class="prog-center">
                    <span class="prog-speed" style="color:var(--green)">Complete ✓</span>
                    <span class="prog-size">${sizeStr}</span>
                </div>
                <div class="prog-status-txt done">Done</div>
            </div>
            ${dlId ? `<button class="save-btn" onclick="saveFile('${dlId}')">💾 File Save Karo</button>` : ''}
        </div>`;
        return;
    }
    const graph = dlId ? buildSpeedGraph(dlId, speedMb) : '';
    container.innerHTML = `<div class="progress-card">
        <div class="progress-label">${typeIcon} ${dlType?.toUpperCase()||''} Download Ho Raha Hai...</div>
        <div class="prog-bar-wrap">
            <div class="prog-bar-fill ${indeterminate?'indeterminate':''}"
                 style="width:${indeterminate?'35':pct}%"></div>
        </div>
        <div class="prog-stats">
            <div class="prog-pct">${pctStr}</div>
            <div class="prog-center">
                <span class="prog-speed">${speedStr||'Calculating...'}</span>
                <span class="prog-size">${sizeStr||'Size fetching...'}</span>
            </div>
            <div class="prog-status-txt downloading">⬇ Live</div>
        </div>
        ${graph}
    </div>`;
}

// ── Save File ──
function saveFile(dlId) {
    showToast('💾 Download shuru ho gaya...');
    const a = document.createElement('a');
    a.href = `/api/get-file/${dlId}`;
    a.setAttribute('download', '');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// ── Queue ──
function addToQueue(platform, dlType) {
    const data = currentData[platform];
    if (!data) { showToast('⚠️ Pehle video info fetch karo!'); return; }
    const fid = selectedFormats[platform]||'best';
    const qualLabel = dlType==='mp3'?'MP3':dlType==='3gp'?'3GP':getQualityLabel(platform);
    queue.push({ id:Date.now(), title:data.title, thumbnail:data.thumbnail,
                  url:data.url, format_id:fid, quality:qualLabel,
                  dlType, platform });
    updateQueueBadge();
    showToast('🕐 Queue mein add ho gaya!');
    if (document.getElementById('section-queue').classList.contains('active')) renderQueueTab();
}

function renderQueueTab() {
    const container = document.getElementById('queue-list-container');
    if (queue.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <div class="empty-icon">📋</div>
            <p>Queue khali hai</p>
            <p style="font-size:12px;margin-top:6px;color:#6b7280">Video page pe "Queue" button dabao</p>
        </div>`;
        return;
    }
    container.innerHTML = queue.map(item => `
        <div class="queue-list-item" id="qli-${item.id}">
            <div class="qli-header">
                ${item.thumbnail
                  ? `<img class="qli-thumb" src="${item.thumbnail}" onerror="this.style.display='none'">`
                  : '<div class="qli-thumb-ph">🎬</div>'}
                <div class="qli-info">
                    <div class="qli-title">${esc(item.title)}</div>
                    <div class="qli-meta">
                        ${item.dlType==='mp3'?'🎵':item.dlType==='3gp'?'📱':'🎬'} ${item.quality}
                        • ${item.platform.charAt(0).toUpperCase()+item.platform.slice(1)}
                    </div>
                </div>
            </div>
            <div class="qli-actions">
                <button class="go-btn" onclick="startQueueItem(${item.id})">▶ GO — Download Karo</button>
                <button class="remove-btn" onclick="removeQueue(${item.id})">✕</button>
            </div>
        </div>`).join('');
}

function removeQueue(id) {
    queue = queue.filter(q => q.id !== id);
    updateQueueBadge();
    renderQueueTab();
    showToast('🗑️ Hata diya');
}

async function startQueueItem(id) {
    const item = queue.find(q => q.id === id);
    if (!item) return;
    queue = queue.filter(q => q.id !== id);
    updateQueueBadge();
    renderQueueTab();

    showToast('▶️ Download shuru ho gaya!');

    // Switch to platform tab and show progress
    switchTab(item.platform);
    const data = currentData[item.platform];
    // Update data if needed
    if (!data || data.url !== item.url) {
        currentData[item.platform] = { ...currentData[item.platform], url:item.url, title:item.title, thumbnail:item.thumbnail, formats:[] };
        selectedFormats[item.platform] = item.format_id;
        // Re-render minimal result view
        const rd = document.getElementById(platformResults[item.platform]);
        if (rd) rd.innerHTML = `<div class="fetching-card"><p>📋 Queue se: <strong>${esc(item.title)}</strong></p></div><div id="prog-${item.platform}"></div>`;
    } else {
        selectedFormats[item.platform] = item.format_id;
        const rd = document.getElementById(platformResults[item.platform]);
        if (rd && !rd.querySelector(`#prog-${item.platform}`)) {
            const div = document.createElement('div');
            div.id = `prog-${item.platform}`;
            rd.appendChild(div);
        }
    }

    try {
        const res = await fetch('/api/start-download', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ url:item.url, format_id:item.format_id,
                                  type:item.dlType, title:item.title, quality:item.quality })
        });
        const json = await res.json();
        if (json.download_id) {
            activeDownloads[json.download_id] = { id:json.download_id, title:item.title,
                quality:item.quality, status:'starting', percent:0,
                downloaded_mb:0, total_mb:0, speed_mb:0 };
            updateBadge();
            const progDiv = document.getElementById(`prog-${item.platform}`);
            listenProgress(item.platform, json.download_id, item.dlType, progDiv);
        }
    } catch { showToast('❌ Error'); }
}

// ── Downloads Panel render ──
function renderDownloadsPanel() {
    const list = document.getElementById('downloads-list');
    const entries = Object.values(activeDownloads);
    if (entries.length === 0) {
        list.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>Koi download nahi chal raha</p></div>`;
        return;
    }
    list.innerHTML = entries.map(dl => {
        const pct = dl.percent||0;
        const dlMb = dl.downloaded_mb||0;
        const totalMb = dl.total_mb||0;
        const speedMb = dl.speed_mb||0;
        const sizeStr = totalMb>0.01 ? `${dlMb.toFixed(2)} / ${totalMb.toFixed(2)} MB` : `${dlMb.toFixed(2)} MB`;
        const speedStr = speedMb>0.001 ? `⚡ ${speedMb.toFixed(2)} MB/s` : '';
        const ind = dl.status==='starting'||(pct===0&&dl.status==='downloading');

        if (dl.status==='done') return `<div class="dl-panel-item">
            <div class="dl-pi-header">
                <div class="dl-pi-title">${esc(dl.title)}</div>
                <div class="dl-pi-quality">${dl.quality}</div>
            </div>
            <div class="prog-bar-wrap"><div class="prog-bar-fill green" style="width:100%"></div></div>
            <div class="dl-pi-stats">
                <span style="color:var(--green);font-size:13px;font-weight:700">✅ Phone mein save ho gaya</span>
                <span style="color:var(--txt2);font-size:11px">${sizeStr}</span>
            </div>
        </div>`;

        if (dl.status==='error') return `<div class="dl-panel-item">
            <div class="dl-pi-header">
                <div class="dl-pi-title">${esc(dl.title)}</div>
                <div class="dl-pi-quality">${dl.quality}</div>
            </div>
            <div style="color:var(--red);font-size:12px;font-weight:700">❌ Failed</div>
        </div>`;

        return `<div class="dl-panel-item">
            <div class="dl-pi-header">
                <div class="dl-pi-title">${esc(dl.title)}</div>
                <div class="dl-pi-quality">${dl.quality}</div>
            </div>
            <div class="prog-bar-wrap">
                <div class="prog-bar-fill ${ind?'indeterminate':''}" style="width:${ind?'35':pct}%"></div>
            </div>
            <div class="dl-pi-stats">
                <span style="color:#a78bfa;font-size:13px;font-weight:800">${ind?'...':Math.round(pct)+'%'}</span>
                ${speedStr?`<span style="color:#a78bfa;font-size:11px;font-weight:700">${speedStr}</span>`:''}
                <span style="color:var(--txt2);font-size:11px">${sizeStr}</span>
            </div>
        </div>`;
    }).join('');
}

// ── Badges ──
function updateBadge() {
    const n = Object.values(activeDownloads).filter(d=>d.status==='downloading'||d.status==='starting').length;
    const b = document.getElementById('dl-badge');
    b.textContent=n; b.style.display=n>0?'flex':'none';
}
function updateQueueBadge() {
    const b = document.getElementById('queue-count-badge');
    b.textContent=queue.length; b.style.display=queue.length>0?'flex':'none';
}

// ── Helpers ──
function formatDuration(s) {
    if (!s) return '';
    const sec=s%60, m=Math.floor(s/60), h=Math.floor(m/60);
    if (h>0) return `${h}:${String(m%60).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
}
function esc(t) {
    const d=document.createElement('div');
    d.appendChild(document.createTextNode(t||'')); return d.innerHTML;
}
function renderError(platform, msg) {
    document.getElementById(platformResults[platform]).innerHTML =
        `<div class="error-card"><div class="error-icon">⚠️</div><div class="error-text">${esc(msg)}</div></div>`;
}
document.addEventListener('keydown', e => {
    if (e.key==='Enter') {
        const s=document.querySelector('.platform-section.active');
        if (s&&s.id!=='section-queue') fetchInfo(s.id.replace('section-',''));
    }
});
