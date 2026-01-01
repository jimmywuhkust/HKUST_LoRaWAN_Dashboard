// watch.js – Set & Watch (node<->gateway) live stats (no 3D)
import { timeAgo, snrCell, rssiCell } from './common.js';

// DOM refs
const nodeListSel       = document.getElementById('nodeList');
const gwListSel         = document.getElementById('gwList');

const watchDevInput     = document.getElementById('watchDevInput');
const watchDevBtn       = document.getElementById('watchDevBtn');
const watchDevPauseBtn  = document.getElementById('watchDevPause');
const tblWatchNodeBody  = document.querySelector('#tblWatchNode tbody');
const nodeEmpty         = document.getElementById('nodeEmpty');

const watchGwInput      = document.getElementById('watchGwInput');
const watchGwBtn        = document.getElementById('watchGwBtn');
const watchGwPauseBtn   = document.getElementById('watchGwPause');
const tblWatchGwBody    = document.querySelector('#tblWatchGw tbody');
const gwEmpty           = document.getElementById('gwEmpty');

// Internal state
let ws = null;
let watchDevSelected = '';
let watchGwSelected  = '';
let watchDevPaused = false;
let watchGwPaused  = false;

const devStats = new Map(); // devEui -> { count, byGw: Map(routerid, {snr, rssi, t}) }
const gwStats  = new Map(); // routerid -> { count, byDev: Map(devEui, {snr, rssi, t}) }

function termPushWarn(txt){
  // No terminal widget on this page; optionally log to console.
  console.warn('[watch]', txt);
}

// ---- Gateway ID normalization & resolver ----
function normGw(id){ return String(id||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function resolveGwKey(input){
  const q = normGw(input);
  if (!q) return '';
  for (const k of gwStats.keys()){
    if (normGw(k) === q) return k;
  }
  for (const k of gwStats.keys()){
    if (normGw(k).endsWith(q)) return k;
  }
  return '';
}

// ---- Rankings ----
function refreshNodeRanking(){
  const arr = Array.from(devStats.entries());
  arr.sort((a,b)=> (b[1]?.count||0) - (a[1]?.count||0));
  nodeListSel.innerHTML='';
  for(const [dev, st] of arr){
    const opt = document.createElement('option');
    opt.value = dev; opt.textContent = `${dev}  ·  ${st.count}`;
    nodeListSel.appendChild(opt);
  }
}
function refreshGatewayRanking(){
  const arr = Array.from(gwStats.entries());
  arr.sort((a,b)=> (b[1]?.count||0) - (a[1]?.count||0));
  gwListSel.innerHTML='';
  for(const [gw, st] of arr){
    const opt = document.createElement('option');
    opt.value = gw; opt.textContent = `${gw}  ·  ${st.count}`;
    gwListSel.appendChild(opt);
  }
}

// ---- Render tables ----
function renderNodeWatch(dev){
  watchDevSelected = dev;
  tblWatchNodeBody.innerHTML='';
  const st = devStats.get(dev);
  if(!st || !st.byGw || st.byGw.size===0){ nodeEmpty.style.display='block'; return; }
  nodeEmpty.style.display='none';
  const rows = Array.from(st.byGw.entries()).map(([gw, v])=>({gw, ...v}));
  rows.sort((a,b)=> (b.snr??-999) - (a.snr??-999));
  for(const r of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="badge">${r.gw}</span></td><td>${snrCell(r.snr)}</td><td>${rssiCell(r.rssi)}</td><td>${timeAgo(r.t)}</td>`;
    tblWatchNodeBody.appendChild(tr);
  }
}
function renderGatewayWatch(gwRaw){
  const key = resolveGwKey(gwRaw) || gwRaw;
  watchGwSelected = key;

  tblWatchGwBody.innerHTML='';
  const st = gwStats.get(key);
  if(!st || !st.byDev || st.byDev.size===0){ gwEmpty.style.display='block'; return; }
  gwEmpty.style.display='none';

  const rows = Array.from(st.byDev.entries()).map(([dev, v])=>({dev, ...v}));
  rows.sort((a,b)=> (b.snr??-999) - (a.snr??-999));
  for(const r of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="badge">${r.dev}</span></td><td>${snrCell(r.snr)}</td><td>${rssiCell(r.rssi)}</td><td>${timeAgo(r.t)}</td>`;
    tblWatchGwBody.appendChild(tr);
  }
}

// ---- Controls ----
watchDevBtn.addEventListener('click', ()=>{ const d = (watchDevInput.value || nodeListSel.value || '').trim(); if(d){ watchDevPaused=false; watchDevPauseBtn.textContent='Pause'; renderNodeWatch(d); }});
watchDevInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ watchDevBtn.click(); }});
nodeListSel.addEventListener('change', ()=>{ watchDevInput.value=''; renderNodeWatch(nodeListSel.value); });

watchGwBtn.addEventListener('click', ()=>{
  const raw = (watchGwInput.value || gwListSel.value || '').trim();
  if(!raw){ termPushWarn('GW watch: empty'); return; }
  watchGwPaused=false; watchGwPauseBtn.textContent='Pause';
  renderGatewayWatch(raw);
});
watchGwInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ watchGwBtn.click(); }});
gwListSel.addEventListener('change', ()=>{ watchGwInput.value=''; renderGatewayWatch(gwListSel.value); });

watchDevPauseBtn.addEventListener('click', ()=>{ watchDevPaused = !watchDevPaused; watchDevPauseBtn.textContent = watchDevPaused ? 'Resume' : 'Pause'; watchDevPauseBtn.setAttribute('aria-pressed', watchDevPaused ? 'true':'false'); });
watchGwPauseBtn.addEventListener('click', ()=>{ watchGwPaused = !watchGwPaused; watchGwPauseBtn.textContent = watchGwPaused ? 'Resume' : 'Pause'; watchGwPauseBtn.setAttribute('aria-pressed', watchGwPaused ? 'true':'false'); });

// ---- WebSocket ----
function connect(url){
  try {
    ws = new WebSocket(url);
  } catch(e) {
    console.warn('WS open error', e);
    return;
  }
  ws.onopen = () => console.log('[watch] WS connected:', url);
  ws.onclose = () => console.log('[watch] WS closed');
  ws.onerror = (e) => console.warn('[watch] WS error', e);
  ws.onmessage = (evt) => {
    const handleText = (text) => {
      if (!text) return;
      if (text.startsWith('Received:')) text = text.substring('Received:'.length).trim();
      try { handlePacket(JSON.parse(text)); return; } catch (_) {}
      const parts = text.split(/\n+/);
      for (const p of parts){
        const s = p.trim(); if (!s) continue;
        try { handlePacket(JSON.parse(s)); } catch (_) {}
      }
    };
    if (typeof evt.data === 'string') handleText(evt.data.trim());
    else if (evt.data instanceof Blob) evt.data.text().then(handleText);
    else if (evt.data instanceof ArrayBuffer) {
      try { handleText(new TextDecoder('utf-8').decode(evt.data)); } catch {}
    }
  };
}

// Ingest packets → stats
function handlePacket(m){
  // Expect m.upinfo array
  if (!Array.isArray(m.upinfo) || m.upinfo.length===0) return;

  const devId = m.DevEui ?? m.DevAddr ?? 'unknown';
  let ds = devStats.get(devId); if(!ds){ ds = { count:0, byGw: new Map() }; devStats.set(devId, ds); }

  for (const u of m.upinfo){
    const keyGw = u.routerid ?? 'gw';
    const now = Date.now();

    // device -> gateway
    ds.count++;
    const gEntry = ds.byGw.get(keyGw) || {};
    if (typeof u.snr==='number')  gEntry.snr  = u.snr;
    if (typeof u.rssi==='number') gEntry.rssi = u.rssi;
    gEntry.t = now;
    ds.byGw.set(keyGw, gEntry);

    // gateway -> device
    let gs = gwStats.get(keyGw); if(!gs){ gs = { count:0, byDev: new Map() }; gwStats.set(keyGw, gs); }
    gs.count++;
    const dEntry = gs.byDev.get(devId) || {};
    if (typeof u.snr==='number')  dEntry.snr  = u.snr;
    if (typeof u.rssi==='number') dEntry.rssi = u.rssi;
    dEntry.t = now;
    gs.byDev.set(devId, dEntry);
  }

  // Update lists
  refreshNodeRanking();
  refreshGatewayRanking();

  // Auto-refresh active watches unless paused
  if (watchDevSelected && !watchDevPaused) renderNodeWatch(watchDevSelected);
  if (watchGwSelected && !watchGwPaused) renderGatewayWatch(watchGwSelected);
}

// ---- boot ----
connect('ws://loranet01.ust.hk:7002/owner-c::2'); // same default as live page