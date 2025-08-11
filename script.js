// ===== element refs =====
const els = {
  video: document.getElementById('video'),
  overlay: document.getElementById('overlay'),
  moodBadge: document.getElementById('moodBadge'),
  cameraSelect: document.getElementById('cameraSelect'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  snapBtn: document.getElementById('snapBtn'),
  mirrorToggle: document.getElementById('mirrorToggle'),
  themeToggle: document.getElementById('themeToggle'),
  autoThemeToggle: document.getElementById('autoThemeToggle'),
  aiWallpaperToggle: document.getElementById('aiWallpaperToggle'),
  topMood: document.getElementById('topMood'),
  topConf: document.getElementById('topConf'),
  fpsBar: document.getElementById('fpsBar'),
  fpsText: document.getElementById('fpsText'),
  facesBar: document.getElementById('facesBar'),
  facesText: document.getElementById('facesText'),
  emotionList: document.getElementById('emotionList'),
  previewMood: document.getElementById('previewMood'),
  applyPreview: document.getElementById('applyPreview'),
  wallpaper: document.getElementById('wallpaper'),
  wallpaperMode: document.getElementById('wallpaperMode'),
};

let human, stream, running = false, rafId = null;

// mood smoothing
let lastMood = 'neutral';
let stableMood = 'neutral';
let sameCount = 0;
const STABLE_FRAMES = 6;
const MIN_CONF = 0.35;

// Wallpaper quality knobs
const WALL_QUALITY = 1.8; // 1.5–2.2 = higher res
const DPR_CAP      = 3;   // allow hi-DPI renders

// ===== helpers =====
const pct = v => `${(v * 100).toFixed(1)}%`;
const clamp01 = v => Math.max(0, Math.min(1, v));
const dpr = () => Math.min(window.devicePixelRatio || 1, DPR_CAP);

function applyMirror() {
  const mirrored = els.mirrorToggle?.checked;
  const t = mirrored ? 'scaleX(-1)' : 'scaleX(1)';
  if (els.video) els.video.style.transform = t;
  if (els.overlay) els.overlay.style.transform = t;
}

function applyThemeForMood(mood) {
  // allow either auto or manual preview to set the theme
  if (!els.autoThemeToggle?.checked && !document.body.classList.contains('preview-active')) return;
  const classes = ['happy','sad','angry','surprised','fearful','disgusted','neutral'].map(m=>`theme-${m}`);
  document.body.classList.remove(...classes);
  document.body.classList.add(`theme-${mood.toLowerCase()}`);
}

// ===== AI-ish wallpaper (on-device canvas) =====
const wallCache = new Map();
const MOOD_STYLES = {
  happy:     { gradA: 'rgba(38,208,124,.24)', gradB: 'rgba(14,19,39,.62)',   palette: ['#26d07c','#4ff0b8','#fff8b5','#2ccf9c'] },
  sad:       { gradA: 'rgba(63,94,251,.20)',  gradB: 'rgba(14,19,39,.72)',   palette: ['#6ea8fe','#86b6ff','#1f5ccc','#9cc9ff'] },
  angry:     { gradA: 'rgba(255,90,84,.24)',  gradB: 'rgba(14,19,39,.68)',   palette: ['#ff5a54','#ff8a73','#ffb199','#ff3b3b'] },
  surprised: { gradA: 'rgba(246,201,69,.28)', gradB: 'rgba(14,19,39,.58)',   palette: ['#ffd166','#f6c945','#fff3a1','#ffc857'] },
  fearful:   { gradA: 'rgba(155,123,255,.24)',gradB: 'rgba(14,19,39,.66)',   palette: ['#9b7bff','#c1adff','#7a5cf0','#bfa4ff'] },
  disgusted: { gradA: 'rgba(83,209,123,.24)', gradB: 'rgba(14,19,39,.68)',   palette: ['#53d17b','#89e3ad','#3bbf76','#baf2cd'] },
  neutral:   { gradA: 'rgba(134,182,255,.20)',gradB: 'rgba(14,19,39,.66)',   palette: ['#86b6ff','#c8dcff','#a8c5ff','#6ea8fe'] },
};

function hexToRgb(hex){const h=hex.replace('#','');const n=parseInt(h.length===3?h.split('').map(c=>c+c).join(''):h,16);return{r:(n>>16)&255,g:(n>>8)&255,b:n&255}}
function rgba(hex,a){const {r,g,b}=hexToRgb(hex);return `rgba(${r},${g},${b},${a})`}
function seededRand(seed){let x=seed|0||123456789;return ()=> (x^=x<<13,x^=x>>>17,x^=x<<5,((x>>>0)/4294967296))}

async function generateWallpaper(mood='neutral', w=1920, h=1080){
  const key = `${mood}:${w}x${h}`;
  if (wallCache.has(key)) return wallCache.get(key);

  const { gradA, gradB, palette } = MOOD_STYLES[mood] || MOOD_STYLES.neutral;
  const rnd = seededRand(Math.floor(Date.now()/1000));

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');

  // base gradient
  const lg = g.createLinearGradient(0,0,w,h);
  lg.addColorStop(0, gradA);
  lg.addColorStop(1, gradB);
  g.fillStyle = lg;
  g.fillRect(0,0,w,h);

  // PASS 1: large soft blobs
  g.globalCompositeOperation = 'lighter';
  const bigCount = 160 + Math.floor(rnd()*80);
  for (let i=0;i<bigCount;i++){
    const x = rnd()*w, y = rnd()*h, r = 90 + rnd()*300;
    const col = palette[Math.floor(rnd()*palette.length)];
    const a  = 0.05 + rnd()*0.08;
    const rg = g.createRadialGradient(x,y,0,x,y,r);
    rg.addColorStop(0, rgba(col,a));
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.beginPath(); g.arc(x,y,r,0,Math.PI*2); g.fill();
  }

  // PASS 2: small/high-frequency blobs (adds crisp details)
  const smallCount = 280 + Math.floor(rnd()*120);
  for (let i=0;i<smallCount;i++){
    const x = rnd()*w, y = rnd()*h, r = 10 + rnd()*70;
    const col = palette[Math.floor(rnd()*palette.length)];
    const a  = 0.10 + rnd()*0.14;
    const rg = g.createRadialGradient(x,y,0,x,y,r);
    rg.addColorStop(0, rgba(col,a));
    rg.addColorStop(0.8, rgba(col, a*0.25));
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.beginPath(); g.arc(x,y,r,0,Math.PI*2); g.fill();
  }

  // subtle grain (crisper)
  g.globalCompositeOperation = 'source-over';
  const img = g.getImageData(0,0,w,h), data = img.data;
  const density = 0.03, nRange = 20, r2 = seededRand(7*3);
  for (let i=0;i<data.length;i+=4){
    if (r2() < density){
      const n = Math.floor(r2()*(nRange*2+1))-nRange;
      data[i]   = Math.min(255, Math.max(0, data[i]  + n));
      data[i+1] = Math.min(255, Math.max(0, data[i+1]+ n));
      data[i+2] = Math.min(255, Math.max(0, data[i+2]+ n));
    }
  }
  g.putImageData(img,0,0);

  const url = c.toDataURL('image/jpeg', 0.95);
  wallCache.set(key, url);
  return url;
}

async function applyGeneratedWallpaper(mood){
  if (!els.aiWallpaperToggle?.checked || !els.wallpaper) return;
  const scale = WALL_QUALITY * dpr();
  const w = Math.max(1280, Math.round(window.innerWidth  * scale));
  const h = Math.max(720,  Math.round(window.innerHeight * scale));
  const url = await generateWallpaper(mood, w, h);

  const ms = MOOD_STYLES[mood] || MOOD_STYLES.neutral;
  els.wallpaper.style.backgroundImage =
    `linear-gradient(135deg, ${ms.gradA}, ${ms.gradB}), url(${url})`;
  els.wallpaper.style.backgroundSize = 'cover';
  els.wallpaper.style.backgroundPosition = 'center';
}

// regenerate helper
async function regenerateCurrent(){
  await applyGeneratedWallpaper(stableMood || 'neutral');
}

// ===== init human.js =====
(async function init(){
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) document.body.setAttribute('data-theme', savedTheme);

  human = new Human.Human({
    modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human/models',
    cacheModels: true,
    warmup: 'face',
    filter: { enabled: true, equalizeHistogram: true },
    face: { enabled: true, detector: { rotation: true, maxDetected: 5 }, mesh: { enabled: true }, emotion: { enabled: true } },
  });

  try { await human.load(); await human.warmup(); }
  catch(e){ console.error(e); alert('Failed to load AI models. Check internet and refresh.'); return; }

  // get labels for devices
  try { const tmp = await navigator.mediaDevices.getUserMedia({video:true,audio:false}); tmp.getTracks().forEach(t=>t.stop()); } catch{}

  await listCameras();

  // initial wallpaper
  applyGeneratedWallpaper('neutral');
})();

async function listCameras(){
  try{
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
    els.cameraSelect.innerHTML = '';
    if (!cams.length){
      const o=document.createElement('option'); o.textContent='No camera found'; o.disabled=true; els.cameraSelect.appendChild(o); return;
    }
    cams.forEach((c,i)=>{
      const opt=document.createElement('option');
      opt.value=c.deviceId; opt.textContent=c.label||`Camera ${i+1}`;
      els.cameraSelect.appendChild(opt);
    });
  }catch(e){ console.warn('enumerateDevices failed', e); }
}

async function startCamera(){
  stopCamera();
  try{
    const deviceId = els.cameraSelect.value || undefined;
    stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId:{ exact: deviceId } } : { facingMode:'user', width:{ideal:1280}, height:{ideal:720} },
      audio:false,
    });
    els.video.srcObject = stream;
    await els.video.play();
    els.overlay.width  = els.video.videoWidth  || 1280;
    els.overlay.height = els.video.videoHeight || 720;
    applyMirror();
    running = true; loop();
  }catch(e){ console.error('Camera error:', e); alert('Cannot access camera. Check permissions or close other apps.'); }
}

function stopCamera(){
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (stream) stream.getTracks().forEach(t=>t.stop());
  stream = null;
}

function snapshot(){
  if (!els.video || !els.overlay) return;
  const c=document.createElement('canvas'); c.width=els.overlay.width; c.height=els.overlay.height;
  const g=c.getContext('2d');
  g.drawImage(els.video,0,0,c.width,c.height);
  g.drawImage(els.overlay,0,0);
  const url=c.toDataURL('image/png');
  const a=document.createElement('a'); a.href=url; a.download=`mood-${Date.now()}.png`; a.click();
}

function renderEmotions(list){
  els.emotionList.innerHTML = '';
  if (!list?.length){ els.emotionList.innerHTML='<div class="muted">No face detected.</div>'; return; }
  list.forEach(e=>{
    const row=document.createElement('div'); row.className='emotion';
    row.innerHTML = `
      <div class="row"><span class="name">${e.emotion}</span><span class="pct">${pct(e.score)}</span></div>
      <div class="bar"><div class="fill" style="width:${pct(e.score)}"></div></div>`;
    els.emotionList.appendChild(row);
  });
}

async function loop(){
  if (!running) return;

  const t0=performance.now();
  const result = await human.detect(els.video);

  // overlays
  const ctx=els.overlay.getContext('2d');
  ctx.clearRect(0,0,els.overlay.width,els.overlay.height);
  human.draw.canvas(els.overlay);
  human.draw.face(els.overlay, result.face, { labels:false });

  // summary
  const faces = result.face || [];
  els.facesText.textContent = String(faces.length);
  els.facesBar.style.width = `${Math.min(100,(faces.length/5)*100)}%`;

  const emotions = faces[0]?.emotion || [];
  renderEmotions(emotions);

  if (emotions.length){
    const top = [...emotions].sort((a,b)=>b.score-a.score)[0];
    els.moodBadge.textContent = `Mood: ${top.emotion} (${pct(top.score)})`;
    els.topMood.textContent = top.emotion;
    els.topConf.style.width = pct(clamp01(top.score));

    const current = top.score >= MIN_CONF ? top.emotion.toLowerCase() : 'neutral';
    if (current === lastMood) sameCount++; else sameCount = 0;
    lastMood = current;
    if (sameCount >= STABLE_FRAMES && current !== stableMood){
      stableMood = current;
      applyThemeForMood(stableMood);
      applyGeneratedWallpaper(stableMood);
    }
  }else{
    els.moodBadge.textContent = 'Mood: —';
    els.topMood.textContent = '—';
    els.topConf.style.width = '0%';
  }

  // fps
  const fps = 1000 / (performance.now()-t0);
  els.fpsText.textContent = `${fps.toFixed(1)} fps`;
  els.fpsBar.style.width = `${Math.min(100,(fps/60)*100)}%`;

  rafId = requestAnimationFrame(loop);
}

// ===== events =====
els.startBtn.addEventListener('click', startCamera);
els.stopBtn.addEventListener('click', stopCamera);
els.snapBtn.addEventListener('click', snapshot);
els.cameraSelect.addEventListener('change', async ()=>{ if (stream) await startCamera(); });
els.mirrorToggle.addEventListener('change', applyMirror);

els.themeToggle.addEventListener('click', ()=>{
  const cur=document.body.getAttribute('data-theme');
  const next=cur==='dark'?'light':'dark';
  document.body.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});

els.autoThemeToggle?.addEventListener('change', ()=>{
  if (els.autoThemeToggle.checked) applyThemeForMood(stableMood||'neutral');
});

els.aiWallpaperToggle?.addEventListener('change', ()=>{
  if (els.aiWallpaperToggle.checked) applyGeneratedWallpaper(stableMood||'neutral');
  else if (els.wallpaper) els.wallpaper.style.backgroundImage = '';
});

// preview (manual)
els.applyPreview?.addEventListener('click', async ()=>{
  if (!els.previewMood) return;
  const mood = els.previewMood.value.toLowerCase();
  document.body.classList.add('preview-active');
  if (els.autoThemeToggle) els.autoThemeToggle.checked = false;
  applyThemeForMood(mood);
  await applyGeneratedWallpaper(mood);
  els.moodBadge.textContent = `Mood: ${mood} (preview)`;
  els.topMood.textContent = mood;
});

// Wallpaper Mode toggle (hide UI)
els.wallpaperMode?.addEventListener('click', ()=>{
  document.body.classList.toggle('wallpaper-only');
});

// keyboard shortcuts
window.addEventListener('keydown', (e)=>{
  const k=e.key.toLowerCase();
  if (k==='s') startCamera();
  if (k==='x') stopCamera();
  if (k==='c') snapshot();
  if (k==='m'){ if (els.mirrorToggle){ els.mirrorToggle.checked=!els.mirrorToggle.checked; applyMirror(); } }
  if (k==='t') els.themeToggle.click();
  if (k==='w') document.body.classList.toggle('wallpaper-only'); // wallpaper mode
  if (k==='r') regenerateCurrent(); // regenerate wallpaper
});

// regenerate wallpaper on resize (debounced)
let resizeTimer;
window.addEventListener('resize', ()=>{
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(regenerateCurrent, 200);
});




