/* fal.ai orchestration — 3 architecture scenes
   Image: fal-ai/nano-banana-2  →  Video: fal-ai/kling-video/v3/pro/image-to-video
   Run with FAL_KEY env var. Outputs go to ./media/. */

const fs = require('fs');
const path = require('path');
const https = require('https');

const KEY = process.env.FAL_KEY;
if (!KEY) { console.error('[fatal] FAL_KEY env var missing'); process.exit(2); }

const OUT = path.join(__dirname, 'media');
fs.mkdirSync(OUT, { recursive: true });

const FAL_AUTH = { Authorization: 'Key ' + KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(url, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search,
      method, headers: { ...headers },
    };
    let payload;
    if (body) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = payload.length;
    }
    const r = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        const isJson = ct.includes('json');
        let parsed = buf;
        if (isJson) {
          try { parsed = JSON.parse(buf.toString('utf-8')); } catch { parsed = buf.toString('utf-8'); }
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function falSubmit(model, input) {
  const r = await req(`https://queue.fal.run/${model}`, { method: 'POST', body: input, headers: FAL_AUTH });
  if (r.status !== 200 && r.status !== 202) {
    throw new Error(`submit ${model} → HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  }
  return r.body;
}

async function falPoll(statusUrl, responseUrl, label, intervalMs, maxMs) {
  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < maxMs) {
    const r = await req(statusUrl, { headers: FAL_AUTH });
    const status = r.body && r.body.status;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    if (elapsed - lastLog >= 10 || status !== 'IN_QUEUE' && status !== 'IN_PROGRESS') {
      console.log(`  [${label}] ${status} (${elapsed}s)`);
      lastLog = elapsed;
    }
    if (status === 'COMPLETED') {
      const f = await req(responseUrl, { headers: FAL_AUTH });
      if (f.status !== 200) throw new Error(`${label} response fetch HTTP ${f.status}: ${JSON.stringify(f.body)}`);
      return f.body;
    }
    if (status === 'FAILED' || status === 'CANCELLED' || status === 'ERROR') {
      throw new Error(`${label} ${status}: ${JSON.stringify(r.body)}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out after ${maxMs}ms`);
}

async function download(url, outPath) {
  const r = await req(url);
  if (r.status !== 200) throw new Error(`download ${url} → HTTP ${r.status}`);
  fs.writeFileSync(outPath, r.body);
  console.log(`  saved → ${path.relative(__dirname, outPath)}  (${r.body.length} bytes)`);
}

/* ─────────────── SCENES ─────────────── */
const SCENES = [
  {
    id: 'atelier',
    imagePrompt: `Cinematic architectural photograph of a modern minimalist architecture studio interior. A long brutalist corridor: raw board-formed concrete walls on the left, a continuous floor-to-ceiling window wall on the right. Hard golden-hour sunlight pours through the windows in directional parallel shafts, casting elongated light beams across a polished concrete floor. Visible volumetric dust particles suspended in the light beams.

Mid-ground: a long solid oak drafting table holds three architectural scale models — a cast-concrete house, a slender wooden tower study, a translucent acrylic massing model. A single Eames-era draughtsman task lamp glows warm. Background: a wide oak desk with rolled blueprints, a brass T-square, an open Moleskine, a single ceramic mug.

Palette: warm sand, ivory, raw concrete grey, deep walnut, soft amber backlight. Atmosphere: silent, contemplative, expensive restraint, editorial architecture magazine.

Camera: low height ~1.1 m, ultra-wide 28 mm anamorphic, 16:9 aspect, slight lens distortion at edges, subtle anamorphic flare from window edge, shallow depth of field with focus locked on the middle drafting table. Cinematic grade — desaturated highlights, warm lifted shadows, deep film blacks (no pure black). Shot on Arri Alexa.

No people. No text. No logos. No on-screen UI. Hyper-realistic, photographic, not illustrated.`,

    videoPrompt: `Slow continuous forward dolly through the corridor at a steady, weightless pace — roughly 25 cm per second, no acceleration, no stops. The camera does not pan, tilt, or rotate. Pure forward motion only.

Volumetric dust particles drift gently downward and sideways through the golden light beams, catching the sun. The light beams themselves breathe imperceptibly, as if the sun is shifting by a fraction of a degree. The draughtsman lamp glow pulses very softly, once.

Subtle anamorphic lens breathing on the window edge flare. Cinematic motion blur on the closest drafting table edge as it passes. The architectural models stay completely still and solid — no warping, no morphing.

No people enter the frame. No text appears. No camera shake. No zoom. Calm, contemplative, slow.`,
  },

  {
    id: 'construction',
    imagePrompt: `Cinematic architectural photograph of a modern building under construction at golden hour. Exposed cast-in-place concrete floor slabs stack three levels high, forming a clean post-and-beam frame against a soft amber sky. The bare concrete is freshly poured — board-form texture still crisp, edges sharp. Vertical steel rebar protrudes from the top slab, catching the last directional sunlight. Lightweight aluminum scaffolding wraps two columns on the left, casting long parallel shadows. A single gantry tower crane rises in the deep background, dark silhouette against the warm sky.

The ground floor is open — polished concrete with construction dust drifting through warm light beams entering between columns. Foreground left: a folding worksite table with rolled blueprints weighted by a brass ruler, a yellow hard hat on its side, a steel measuring tape, a dusty thermos.

Color palette: warm sand sky, cool concrete grey, oxidized steel, deep amber sun, charcoal shadows. Atmosphere: just-after-quitting-time silence, contemplative scale, unfinished but intentional, editorial architecture magazine.

Camera: low angle ~1 m, ultra-wide 24 mm anamorphic, 16:9 aspect, slight anamorphic flare from the horizon, deep field focus. Cinematic grade — desaturated mid-tones, warm sun, deep film blacks (no pure black). Shot on Arri Alexa.

No people. No text. No logos. Hyper-realistic, photographic, not illustrated.`,

    videoPrompt: `Slow continuous forward dolly through the exposed structural frame at a steady, weightless pace — about 20 cm per second. Pure forward motion. No pan, tilt, or rotation.

Construction dust drifts gently through the warm light beams between columns, catching the last sun. Long shadows from the scaffolding shift imperceptibly as the sun lowers. The distant tower crane stays absolutely still. The hard hat in the foreground sits motionless. A few loose blueprint corners flutter once, very softly.

Subtle anamorphic lens breathing on the horizon flare. The concrete slabs and steel rebar remain completely solid — no warping or morphing of structure.

No people enter the frame. No text. No camera shake. No zoom. Calm, contemplative, slow.`,
  },

  {
    id: 'delivered',
    imagePrompt: `Cinematic architectural photograph of a finished contemporary residential villa at deep blue twilight. Two-story modern building: raw board-formed concrete walls with vertical western red cedar slat cladding on the right wing, a continuous floor-to-ceiling window wall on the front. Internal warm 2700K interior lights are just turned on, glowing amber from within and spilling onto the entrance terrace.

A perfectly reflective shallow water pool runs along the entire front facade — the building doubles in the still water. The sky is deep navy fading to soft horizon orange behind the building silhouette. Foreground: smooth dark basalt pavers, slightly wet from recent rain, subtle reflections. A single mature Japanese maple tree stands on the right, its red leaves catching the last sky light. Low ambient mist hovers over the water pool.

Color palette: deep navy sky, slate grey concrete, warm amber interior glow, copper-red leaves, bronze trim accents. Atmosphere: serene, expensive, complete, just-handed-over, editorial architecture magazine cover.

Camera: eye-level ~1.5 m, ultra-wide 28 mm anamorphic, 16:9 aspect, mild anamorphic flare from a window, deep depth of field. Cinematic grade — crushed shadows but lifted blacks (no pure black), warm interior glow vs. cool exterior twilight, subtle film grain. Shot on Arri Alexa.

No people. No text. No logos. No on-screen UI. Hyper-realistic, photographic, not illustrated.`,

    videoPrompt: `Slow continuous forward dolly toward the villa at a steady, weightless pace — about 25 cm per second. Pure forward motion. No pan, tilt, or rotation.

The interior amber lights pulse very softly, as if someone inside subtly dims a lamp. Reflections on the water pool ripple gently from a barely perceptible breeze — small concentric ripples. The Japanese maple's leaves rustle once, almost imperceptibly. Low ambient mist drifts slowly across the water surface. The deep blue twilight sky stays fixed.

The building structure remains completely solid — no warping, no morphing of walls, windows, or cladding.

No people enter the frame. No text appears. No camera shake. No zoom. Calm, contemplative, slow.`,
  },
];

const NEG_VIDEO = 'people, person, human, text, watermark, logo, distortion, morphing, warping buildings, warping models, fast motion, camera shake, zoom, blur, low quality';

/* ─────────────── ORCHESTRATE ─────────────── */
(async () => {
  const t0 = Date.now();
  console.log(`[start] ${new Date().toISOString()}\n`);

  /* 1. submit all 3 image jobs in parallel */
  console.log('1/3  Submitting 3 image jobs to Nano Banana 2…');
  const imgJobs = await Promise.all(SCENES.map(s =>
    falSubmit('fal-ai/nano-banana-2', {
      prompt: s.imagePrompt,
      aspect_ratio: '16:9',
      resolution: '2K',
      output_format: 'jpeg',
      num_images: 1,
    }).then(j => {
      console.log(`  submitted img:${s.id}  request_id=${j.request_id}`);
      return { scene: s, job: j };
    })
  ));

  /* 2. poll all image jobs */
  console.log('\n   Polling image jobs…');
  const images = await Promise.all(imgJobs.map(({ scene, job }) =>
    falPoll(job.status_url, job.response_url, `img:${scene.id}`, 4000, 5 * 60 * 1000)
      .then(out => {
        const url = out.images && out.images[0] && out.images[0].url;
        if (!url) throw new Error(`img:${scene.id} no url in response: ${JSON.stringify(out)}`);
        return { scene, imageUrl: url };
      })
  ));

  /* 3. download images */
  console.log('\n   Downloading images…');
  for (const { scene, imageUrl } of images) {
    await download(imageUrl, path.join(OUT, `${scene.id}.jpg`));
  }

  /* 4. submit all 3 video jobs in parallel */
  console.log('\n2/3  Submitting 3 video jobs to Kling v3 Pro…');
  const vidJobs = await Promise.all(images.map(({ scene, imageUrl }) =>
    falSubmit('fal-ai/kling-video/v3/pro/image-to-video', {
      start_image_url: imageUrl,
      prompt: scene.videoPrompt,
      duration: '5',
      generate_audio: false,
      cfg_scale: 0.5,
      negative_prompt: NEG_VIDEO,
    }).then(j => {
      console.log(`  submitted vid:${scene.id}  request_id=${j.request_id}`);
      return { scene, job: j };
    })
  ));

  /* 5. poll all video jobs (slower — Kling can take 2-5 min each) */
  console.log('\n   Polling video jobs (this may take several minutes)…');
  const videos = await Promise.all(vidJobs.map(({ scene, job }) =>
    falPoll(job.status_url, job.response_url, `vid:${scene.id}`, 8000, 20 * 60 * 1000)
      .then(out => {
        const url = out.video && out.video.url;
        if (!url) throw new Error(`vid:${scene.id} no url in response: ${JSON.stringify(out)}`);
        return { scene, videoUrl: url };
      })
  ));

  /* 6. download videos */
  console.log('\n3/3  Downloading videos…');
  for (const { scene, videoUrl } of videos) {
    await download(videoUrl, path.join(OUT, `${scene.id}.mp4`));
  }

  const totalSec = Math.round((Date.now() - t0) / 1000);
  console.log(`\n[done]  ${totalSec}s  →  3 jpg + 3 mp4 in ./media/`);

  /* write a small manifest for the site to consume */
  const manifest = {
    generatedAt: new Date().toISOString(),
    durationSec: totalSec,
    scenes: SCENES.map(s => ({ id: s.id, image: `media/${s.id}.jpg`, video: `media/${s.id}.mp4` })),
  };
  fs.writeFileSync(path.join(__dirname, 'media', 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('       manifest.json written');
})().catch(err => {
  console.error('\n[FATAL]', err.message || err);
  process.exit(1);
});
