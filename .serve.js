/* static dev server with HTTP Range support — required for smooth video scrubbing */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const root = __dirname;
const port = 5173;

const TYPES = {
  '.html':'text/html; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml',
  '.png':'image/png',
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.webp':'image/webp',
  '.mp4':'video/mp4',
  '.webm':'video/webm',
  '.ico':'image/x-icon',
  '.woff2':'font/woff2',
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body) res.end(body); else res.end();
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) return send(res, 403, { 'content-type': 'text/plain' }, '403');

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { 'content-type': 'text/plain' }, '404 ' + p);
    const type  = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const total = st.size;
    const range = req.headers.range;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end   = m[2] ? parseInt(m[2], 10) : total - 1;
        if (isNaN(start) || isNaN(end) || start > end || end >= total) {
          return send(res, 416, { 'content-range': 'bytes */' + total });
        }
        res.writeHead(206, {
          'content-type': type,
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${total}`,
          'accept-ranges': 'bytes',
          'cache-control': 'no-cache',
        });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': total,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, () => console.log('serving ' + root + ' on http://localhost:' + port));
