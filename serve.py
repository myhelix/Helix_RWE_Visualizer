#!/usr/bin/env python3
"""Local dev server with gzip compression for JSON files.
Speeds up large gene files (e.g. TTN: 18MB -> 4MB over the wire).
"""
import gzip, os, sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

_gz_cache = {}  # path -> (mtime, compressed_bytes)

def get_compressed(path):
    mtime = os.path.getmtime(path)
    if _gz_cache.get(path, (None,))[0] != mtime:
        with open(path, 'rb') as f:
            _gz_cache[path] = (mtime, gzip.compress(f.read(), compresslevel=6))
    return _gz_cache[path][1]

class GzipHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        accepts_gzip = 'gzip' in self.headers.get('Accept-Encoding', '')
        if accepts_gzip and self.path.endswith('.json'):
            fs_path = self.translate_path(self.path)
            if os.path.isfile(fs_path):
                data = get_compressed(fs_path)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Encoding', 'gzip')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(data)
                return
        super().do_GET()

    def log_message(self, fmt, *args):
        # Suppress per-request noise; only show errors
        if args and str(args[1]) not in ('200', '304'):
            super().log_message(fmt, *args)

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f'Starting server at http://localhost:{port}  (gzip enabled)')
    print('Press Ctrl+C to stop.')
    HTTPServer(('', port), GzipHandler).serve_forever()
