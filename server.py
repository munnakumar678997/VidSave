import os
import re
import json
import uuid
import time
import tempfile
import threading
import subprocess
from flask import Flask, request, jsonify, send_file, render_template, Response, stream_with_context
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

downloads = {}

@app.after_request
def add_headers(response):
    response.headers['X-Frame-Options'] = 'ALLOWALL'
    response.headers['Content-Security-Policy'] = "frame-ancestors *"
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
    return response

SUPPORTED_DOMAINS = {
    'youtube':   ['youtube.com', 'youtu.be', 'www.youtube.com'],
    'instagram': ['instagram.com', 'www.instagram.com'],
    'facebook':  ['facebook.com', 'www.facebook.com', 'fb.watch', 'fb.com']
}

# yt-dlp progress line regex:
# [download]  45.3% of   25.00MiB at    1.23MiB/s ETA 00:13
PROGRESS_RE = re.compile(
    r'\[download\]\s+([\d.]+)%\s+of\s+([\d.]+)([KMGTkmgt]i?B)\s+at\s+([\d.]+)([KMGTkmgt]i?B)/s'
)

def to_mb(value, unit):
    unit = unit.upper()
    if 'G' in unit:  return value * 1024
    if 'M' in unit:  return value
    if 'K' in unit:  return value / 1024
    return value / (1024 * 1024)

def detect_platform(url):
    for platform, domains in SUPPORTED_DOMAINS.items():
        for domain in domains:
            if domain in url:
                return platform
    return None

def get_video_info(url):
    try:
        cmd = ['yt-dlp', '--dump-json', '--no-playlist', '--quiet', url]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return None, result.stderr or "Video info fetch karne mein error aaya"
        info = json.loads(result.stdout)
        formats = []
        seen = set()
        for f in info.get('formats', []):
            height = f.get('height')
            vcodec = f.get('vcodec', 'none')
            format_id = f.get('format_id', '')
            filesize = f.get('filesize') or f.get('filesize_approx')
            if vcodec == 'none' or not height:
                continue
            label = f"{height}p"
            if label in seen:
                continue
            seen.add(label)
            size_mb = round(filesize / (1024 * 1024), 1) if filesize else None
            formats.append({'format_id': format_id, 'quality': label,
                            'height': height, 'ext': f.get('ext','mp4'), 'size_mb': size_mb})
        formats.sort(key=lambda x: x['height'], reverse=True)
        return {
            'title':    info.get('title', 'Video'),
            'thumbnail': info.get('thumbnail', ''),
            'duration': info.get('duration', 0),
            'uploader': info.get('uploader', ''),
            'formats':  formats,
            'url':      url
        }, None
    except subprocess.TimeoutExpired:
        return None, "Request timeout ho gaya. Dobara try karo."
    except json.JSONDecodeError:
        return None, "Video parse karne mein problem aayi."
    except Exception as e:
        return None, str(e)

def run_download(dl_id, url, format_id, dl_type):
    dl = downloads[dl_id]
    tmpdir = tempfile.mkdtemp()
    output_template = os.path.join(tmpdir, '%(title)s.%(ext)s')

    if dl_type == 'mp3':
        cmd = ['yt-dlp', '--extract-audio', '--audio-format', 'mp3',
               '--audio-quality', '0', '--no-playlist', '--newline',
               '-o', output_template, url]
    elif dl_type == '3gp':
        cmd = ['yt-dlp', '-f', 'worst[ext=3gp]/worst',
               '--no-playlist', '--newline', '--recode-video', '3gp',
               '-o', output_template, url]
    else:
        cmd = ['yt-dlp', '-f', f'{format_id}+bestaudio/{format_id}/best',
               '--merge-output-format', 'mp4', '--no-playlist', '--newline',
               '-o', output_template, url]

    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True)
        dl['pid'] = proc.pid
        dl['status'] = 'downloading'

        for line in iter(proc.stdout.readline, ''):
            line = line.strip()
            m = PROGRESS_RE.search(line)
            if m:
                percent   = float(m.group(1))
                total_raw = float(m.group(2))
                total_unit = m.group(3)
                speed_raw  = float(m.group(4))
                speed_unit = m.group(5)

                total_mb = to_mb(total_raw, total_unit)
                speed_mb = to_mb(speed_raw, speed_unit)
                downloaded_mb = total_mb * percent / 100.0

                dl['percent']       = round(percent, 1)
                dl['total_mb']      = round(total_mb, 2)
                dl['downloaded_mb'] = round(downloaded_mb, 2)
                dl['speed_mb']      = round(speed_mb, 3)

        proc.wait()
        files = [f for f in os.listdir(tmpdir) if not f.endswith('.part')]
        if proc.returncode == 0 and files:
            dl['status']   = 'done'
            dl['percent']  = 100
            dl['filepath'] = os.path.join(tmpdir, files[0])
            dl['filename'] = files[0]
        else:
            dl['status'] = 'error'
            dl['error']  = 'Download fail hua. Dobara try karo.'
    except Exception as e:
        dl['status'] = 'error'
        dl['error']  = str(e)

@app.route('/favicon.ico')
def favicon():
    return '', 204

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/info', methods=['POST'])
def video_info():
    data = request.get_json()
    url  = data.get('url', '').strip()
    if not url:
        return jsonify({'error': 'URL dalo pehle!'}), 400
    platform = detect_platform(url)
    if not platform:
        return jsonify({'error': 'Sirf YouTube, Instagram aur Facebook URLs support hote hain.'}), 400
    info, error = get_video_info(url)
    if error:
        return jsonify({'error': error}), 500
    info['platform'] = platform
    return jsonify(info)

@app.route('/api/start-download', methods=['POST'])
def start_download():
    data      = request.get_json()
    url       = data.get('url', '').strip()
    format_id = data.get('format_id', 'best')
    dl_type   = data.get('type', 'video')   # 'video' | 'mp3' | '3gp'
    title     = data.get('title', 'Video')
    quality   = data.get('quality', '')

    if not url:
        return jsonify({'error': 'URL missing hai'}), 400

    dl_id = str(uuid.uuid4())[:8]
    downloads[dl_id] = {
        'id': dl_id, 'url': url, 'title': title, 'quality': quality,
        'status': 'starting', 'percent': 0,
        'downloaded_mb': 0.0, 'total_mb': 0.0, 'speed_mb': 0.0,
        'filepath': None, 'filename': None, 'error': None,
        'started_at': time.time()
    }

    t = threading.Thread(target=run_download,
                         args=(dl_id, url, format_id, dl_type), daemon=True)
    t.start()
    return jsonify({'download_id': dl_id})

@app.route('/api/progress/<dl_id>')
def progress_stream(dl_id):
    def generate():
        while True:
            dl = downloads.get(dl_id)
            if not dl:
                yield f"data: {json.dumps({'error': 'Not found'})}\n\n"
                break
            payload = {
                'status':       dl['status'],
                'percent':      dl['percent'],
                'downloaded_mb': dl['downloaded_mb'],
                'total_mb':     dl['total_mb'],
                'speed_mb':     dl['speed_mb'],
                'title':        dl['title'],
                'quality':      dl['quality'],
                'filename':     dl['filename'],
                'error':        dl['error']
            }
            yield f"data: {json.dumps(payload)}\n\n"
            if dl['status'] in ('done', 'error'):
                break
            time.sleep(0.5)
    return Response(stream_with_context(generate()),
                    mimetype='text/event-stream',
                    headers={'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache'})

@app.route('/api/get-file/<dl_id>')
def get_file(dl_id):
    dl = downloads.get(dl_id)
    if not dl or dl['status'] != 'done' or not dl['filepath']:
        return jsonify({'error': 'File ready nahi hai'}), 404
    is_mp3 = dl['filename'].endswith('.mp3')
    is_3gp = dl['filename'].endswith('.3gp')
    if is_mp3:   mime = 'audio/mpeg'
    elif is_3gp: mime = 'video/3gpp'
    else:        mime = 'video/mp4'
    return send_file(dl['filepath'], mimetype=mime,
                     as_attachment=True, download_name=dl['filename'])

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
