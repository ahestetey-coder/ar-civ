// minimal MP4 box probe — duration + resolution, no external deps
const fs = require('fs');
const f = process.argv[2];
const buf = fs.readFileSync(f);

function* boxes(start, end) {
  let p = start;
  while (p + 8 <= end) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    let dataStart = p + 8;
    let realSize = size;
    if (size === 1) { realSize = Number(buf.readBigUInt64BE(p + 8)); dataStart = p + 16; }
    else if (size === 0) { realSize = end - p; }
    yield { type, start: p, dataStart, end: p + realSize };
    p += realSize;
  }
}

function find(parent, type) {
  for (const b of boxes(parent.dataStart, parent.end)) if (b.type === type) return b;
  return null;
}

const root = { dataStart: 0, end: buf.length };
const moov = find(root, 'moov');
if (!moov) { console.log('no moov'); process.exit(1); }
const mvhd = find(moov, 'mvhd');
const v = buf[mvhd.dataStart];
const off = v === 1 ? 28 : 16;
const timescale = buf.readUInt32BE(mvhd.dataStart + off - 4);
const dur = v === 1 ? Number(buf.readBigUInt64BE(mvhd.dataStart + off)) : buf.readUInt32BE(mvhd.dataStart + off);
const seconds = dur / timescale;

let width = 0, height = 0;
for (const trak of (function*() { for (const b of boxes(moov.dataStart, moov.end)) if (b.type === 'trak') yield b; })()) {
  const tkhd = find(trak, 'tkhd');
  if (!tkhd) continue;
  const tv = buf[tkhd.dataStart];
  const tkOff = tv === 1 ? 88 : 76;
  const w = buf.readUInt32BE(tkhd.dataStart + tkOff) / 65536;
  const h = buf.readUInt32BE(tkhd.dataStart + tkOff + 4) / 65536;
  if (w > width) { width = w; height = h; }
}

const sizeMB = buf.length / (1024 * 1024);
const bitrate = (buf.length * 8) / seconds / 1_000_000;
console.log(JSON.stringify({
  size_MB:  +sizeMB.toFixed(2),
  duration_s: +seconds.toFixed(2),
  resolution: `${width}x${height}`,
  bitrate_Mbps: +bitrate.toFixed(2),
}, null, 2));
