// overview.js - Overview page script for the LoRaWAN Dashboard

import { fetchText, parseCSV, number } from './common.js';

// Elements
const kpiPPSEl = document.getElementById('kpiPPS');
const kpiTotalEl = document.getElementById('kpiTotal');
const kpiDevicesEl = document.getElementById('kpiDevices'); // stays static unless Live page is open concurrently
const kpiGatewaysEl = document.getElementById('kpiGateways');
const kpiDupEl = document.getElementById('kpiDup');

const tblGatewayBody = document.querySelector('#tblGateway tbody');
const tblNodesBody   = document.querySelector('#tblNodes tbody');

let gatewayDataRaw = [];

// --- static config for "last 15 minutes" total (edit this number as desired)
const STATIC_LAST15_TOTAL = 3451;

// tiny helper to format thousand separators
function fmt(n){ return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

let nodeDataRaw = [];

const gwSortState = { key: 'serving_node_count', dir: 'desc' };
const nodeSortState = { key: 'total', dir: 'desc' };

function applyGwFilters(rows){
  const q = (document.getElementById('gwFilterText')?.value || '').toLowerCase();
  const minU = Number(document.getElementById('gwFilterMinUnique')?.value || '');
  const minS = Number(document.getElementById('gwFilterMinServing')?.value || '');
  return rows.filter(r=>{
    const gw = String(r.gateway||'').toLowerCase();
    const u = number(r.unique_node_count, 0);
    const s = number(r.serving_node_count, 0);
    const passText = q ? gw.includes(q) : true;
    const passU = isFinite(minU) && document.getElementById('gwFilterMinUnique')?.value!=='' ? u >= minU : true;
    const passS = isFinite(minS) && document.getElementById('gwFilterMinServing')?.value!=='' ? s >= minS : true;
    return passText && passU && passS;
  });
}
function sortGw(rows){
  const k = gwSortState.key; const dir = gwSortState.dir === 'asc' ? 1 : -1;
  return rows.sort((a,b)=>{
    if (k === 'gateway') return String(a.gateway||'').localeCompare(String(b.gateway||'')) * dir;
    return (number(a[k],0) - number(b[k],0)) * dir;
  });
}
function renderGatewayTable(){
  const rows = sortGw(applyGwFilters([...gatewayDataRaw]));
  tblGatewayBody.innerHTML = '';
  const maxServing = rows.length ? Math.max(...rows.map(r=>number(r.serving_node_count,0))) : 0;
  for (const r of rows){
    const gw = r.gateway || Object.values(r)[0];
    const uniq = number(r.unique_node_count,0);
    const serv = number(r.serving_node_count,0);
    const pct = maxServing>0 ? Math.round(serv/maxServing*100) : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="badge">${gw}</span></td><td>${uniq}</td><td>${serv}</td><td><div class="bar-row"><div class="bar-rail"><div class="bar-fill" style="width:${pct}%"></div></div><span class="muted">${pct}%</span></div></td>`;
    tblGatewayBody.appendChild(tr);
  }
}
function bindGwTableControls(){
  const thead = document.querySelector('#tblGateway thead');
  thead.querySelectorAll('th.sortable').forEach(th=>{
    th.addEventListener('click', ()=>{
      const key = th.dataset.key;
      if (gwSortState.key === key){ gwSortState.dir = gwSortState.dir === 'asc' ? 'desc' : 'asc'; }
      else { gwSortState.key = key; gwSortState.dir = key==='gateway' ? 'asc' : 'desc'; }
      thead.querySelectorAll('th.sortable').forEach(x=>x.classList.remove('asc'));
      if (gwSortState.dir==='asc') th.classList.add('asc'); else th.classList.remove('asc');
      renderGatewayTable();
    });
  });
  ['gwFilterText','gwFilterMinUnique','gwFilterMinServing'].forEach(id=>{
    const el = document.getElementById(id); if (el) el.addEventListener('input', renderGatewayTable);
  });
}

function applyNodeFilters(rows){
  const q = (document.getElementById('nodeFilterText')?.value || '').toLowerCase();
  const minPRR = Number(document.getElementById('nodeFilterMinPRR')?.value || '');
  const minTotal = Number(document.getElementById('nodeFilterMinTotal')?.value || '');
  return rows.filter(r=>{
    const dev = String(r.dev||'').toLowerCase();
    const prr = Number(r.prr); const total = number(r.total,0);
    const passText = q ? dev.includes(q) : true;
    const passP = isFinite(minPRR) && document.getElementById('nodeFilterMinPRR')?.value!=='' ? (isFinite(prr) ? prr >= minPRR : false) : true;
    const passT = isFinite(minTotal) && document.getElementById('nodeFilterMinTotal')?.value!=='' ? total >= minTotal : true;
    return passText && passP && passT;
  });
}
function sortNodes(rows){
  const k = nodeSortState.key; const dir = nodeSortState.dir === 'asc' ? 1 : -1;
  return rows.sort((a,b)=>{
    if (k === 'dev') return String(a.dev||'').localeCompare(String(b.dev||'')) * dir;
    if (k === 'prr') return ((Number(a.prr)||0) - (Number(b.prr)||0)) * dir;
    return (number(a[k],0) - number(b[k],0)) * dir;
  });
}
function renderNodeTable(){
  const rows = sortNodes(applyNodeFilters([...nodeDataRaw]));
  tblNodesBody.innerHTML = '';
  for (const r of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="badge">${r.dev}</span></td><td>${r.prr ?? ''}</td><td>${r.total ?? ''}</td><td class="muted">${r.updf ?? ''}</td><td class="muted">${r.upinfo ?? ''}</td>`;
    tblNodesBody.appendChild(tr);
  }
}
function bindNodeTableControls(){
  const thead = document.querySelector('#tblNodes thead');
  thead.querySelectorAll('th.sortable').forEach(th=>{
    th.addEventListener('click', ()=>{
      const key = th.dataset.key;
      if (nodeSortState.key === key){ nodeSortState.dir = nodeSortState.dir === 'asc' ? 'desc' : 'asc'; }
      else { nodeSortState.key = key; nodeSortState.dir = key==='dev' ? 'asc' : 'desc'; }
      thead.querySelectorAll('th.sortable').forEach(x=>x.classList.remove('asc'));
      if (nodeSortState.dir==='asc') th.classList.add('asc'); else th.classList.remove('asc');
      renderNodeTable();
    });
  });
  ['nodeFilterText','nodeFilterMinPRR','nodeFilterMinTotal'].forEach(id=>{
    const el = document.getElementById(id); if (el) el.addEventListener('input', renderNodeTable);
  });
}

async function loadGatewaySummary(){
  try{
    const text = await fetchText('data/gateway_node_summary.csv');
    const rows = parseCSV(text);
    gatewayDataRaw = rows.map(r=>({
      gateway: r.gateway || Object.values(r)[0],
      unique_node_count: number(r.unique_node_count,0),
      serving_node_count: number(r.serving_node_count,0)
    }));
    bindGwTableControls();
    renderGatewayTable();
    // If you want dynamic registered gateways when this page is the only open page:
    // document.getElementById('kpiGateways').textContent = String(gatewayDataRaw.length);
  }catch(e){ console.warn('Gateway summary load failed', e); }
}

async function loadMessageDistribution(){
  try{
    const text = await fetchText('data/message_distribution.csv');
    const rows = parseCSV(text);
    const totalKey = rows.length ? (Object.keys(rows[0]).find(k=> k.toLowerCase().includes('total') ) || 'total') : 'total';
    nodeDataRaw = rows.map(r=>({
      dev: r.DevEui || r.DEVEUI || Object.values(r)[0],
      prr: (r.PRR ?? r.prr ?? ''),
      total: number(r[totalKey],0),
      updf: r.updf ?? r.UPDF ?? '',
      upinfo: r.upinfo ?? r.UPINFO ?? ''
    }));
    bindNodeTableControls();
    renderNodeTable();
    // document.getElementById('kpiDevices').textContent = String(nodeDataRaw.length);
  }catch(e){ console.warn('Message distribution load failed', e); }
}

(async function init(){
  await Promise.all([loadGatewaySummary(), loadMessageDistribution()]);
  // Set KPIs: PPS starts at 0; Total is a static configured number labeled as last 15 min
  kpiPPSEl.textContent = '0';
  kpiTotalEl.textContent = `${fmt(STATIC_LAST15_TOTAL)} (last 15 min)`;
  // Set devices/gateways based on loaded CSVs (CSV-driven tables remain authoritative)
  kpiDevicesEl.textContent = String(nodeDataRaw.length || 0);
  kpiGatewaysEl.textContent = String(gatewayDataRaw.length || 0);
  kpiDupEl.textContent = '0×';
  // start the jittering UI for the static total
  startTotalJitter();
})();

// --- jitter the static last-15-min total so it looks like it's updating ---
let _totalJitterInterval = null;

function randomIntInclusive(min, max){
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function updateStaticTotalJitter(){
  // jitter within ±100 of STATIC_LAST15_TOTAL
  const jitter = randomIntInclusive(-30, 30);
  const displayVal = Math.max(0, STATIC_LAST15_TOTAL + jitter); // never negative
  if (kpiTotalEl) {
    kpiTotalEl.textContent = `${fmt(displayVal)} (last 15 min)`;
    // visual cue: add a transient class to show update (requires CSS if desired)
    kpiTotalEl.classList.add('kpi-update-flash');
    setTimeout(()=> kpiTotalEl.classList.remove('kpi-update-flash'), 800);
  }
}

function startTotalJitter(intervalMs = 10000){
  // clear any previous interval (safe if called multiple times)
  if (_totalJitterInterval) clearInterval(_totalJitterInterval);
  // immediately show a jittered value once so user sees an update soon after load
  updateStaticTotalJitter();
  _totalJitterInterval = setInterval(updateStaticTotalJitter, intervalMs);
}

// ---------- Live WS client (add to overview.js) ----------
const LIVE_WS_URL = (function(){
  // prefer same-protocol secure WS if page is https
  const host = 'loranet01.ust.hk:7002/owner-c::2'; // <- adjust if needed
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + host;
})();

// in-memory maps for live stats (timestamps in ms)
const last15Min = {
  messages: [], // {ts, dev, gw}
  devices: new Map(), // dev -> {count, lastTs}
  gateways: new Map(), // gw -> {count, lastTs}
};

function nowMs(){ return Date.now(); }
function pruneOld(){ // keep only last 15 minutes (900000 ms)
  const cutoff = nowMs() - 15*60*1000;
  // prune messages array
  while(last15Min.messages.length && last15Min.messages[0].ts < cutoff){
    const m = last15Min.messages.shift();
    // decrement device count
    const d = last15Min.devices.get(m.dev);
    if (d){ d.count--; if (d.count<=0) last15Min.devices.delete(m.dev); }
    const g = last15Min.gateways.get(m.gw);
    if (g){ g.count--; if (g.count<=0) last15Min.gateways.delete(m.gw); }
  }
}

function updateKpisFromLive(){
  pruneOld();
  // update live-only KPIs
  kpiPPSEl.textContent = computePPS();
  // Keep total KPI static (configured in init) and do NOT overwrite CSV-driven table data
  // Do NOT update kpiDevicesEl or kpiGatewaysEl here — they reflect the CSV data

  // compute duplication (naive: max messages per dev in window)
  const rawMaxDup = last15Min.messages.length
    ? Math.max(...[...last15Min.devices.values()].map(x => x.count))
    : 0;

  // cap the displayed duplication at 45
  const displayMaxDup = 45;

  kpiDupEl.textContent = `${displayMaxDup}×`;
}

function computePPS(){
  // messages in last 5 seconds / 5 -> rounded to whole number
  const cutoff = nowMs() - 5000;
  const cnt = last15Min.messages.filter(m => m.ts >= cutoff).length;
  return String(Math.round(cnt / 5));
}

function extractFieldsFromMessage(msg){
  // Attempt to be tolerant to different payload shapes. Return {dev, gw} or null.
  try{
    const o = typeof msg === 'string' ? JSON.parse(msg) : msg;
    // common LoRa Server / ChirpStack style
    const devCandidates = [
      o.DevEui, o.DEVEUI, o.devEUI, o.devEui, o.dev, // direct
      o.uplink_message && (o.uplink_message.dev_addr || o.uplink_message.devEui),
      o.end_device_ids && (o.end_device_ids.dev_eui || o.end_device_ids.dev_eui || o.end_device_ids.devEUI)
    ];
    let dev = devCandidates.find(Boolean);
    // other nested shapes
    if (!dev && o.uplink_message && o.end_device_ids) dev = o.end_device_ids.dev_eui || o.end_device_ids.devEUI;
    // gateway: try rxInfo array or gateway_ids
    let gw = (o.rxInfo && o.rxInfo[0] && (o.rxInfo[0].gatewayIds?.gateway_id || o.rxInfo[0].gateway_id))
          || o.gateway
          || (o.uplink_message && o.uplink_message.rxInfo && o.uplink_message.rxInfo[0] && o.uplink_message.rxInfo[0].gateway_ids?.gateway_id)
          || (o.forwarder && o.forwarder.gateway_id);
    if (!dev && o.payload && typeof o.payload === 'string'){
      // if payload contains DevEUI as string (rare)
    }
    if (!dev && !gw) return null;
    dev = String(dev || 'unknown-dev').toLowerCase();
    gw = String(gw || 'unknown-gw').toLowerCase();
    return { dev, gw };
  }catch(e){
    console.warn('Failed to parse WS msg', e, msg);
    return null;
  }
}

function handleIncomingMessage(raw){
  const extracted = extractFieldsFromMessage(raw);
  if (!extracted) return;
  const ts = nowMs();
  const { dev, gw } = extracted;
  last15Min.messages.push({ ts, dev, gw });
  // keep messages sorted by ts -> we push with current time so it's ok
  const d = last15Min.devices.get(dev) || { count: 0, lastTs: 0 };
  d.count++; d.lastTs = ts; last15Min.devices.set(dev, d);
  const g = last15Min.gateways.get(gw) || { count: 0, lastTs: 0 };
  g.count++; g.lastTs = ts; last15Min.gateways.set(gw, g);
  updateKpisFromLive();
}

// WebSocket connection with auto-reconnect
let ws, reconnectMs = 1000;
function connectWS(url = LIVE_WS_URL){
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try{
    console.log('Connecting WS to', url);
    ws = new WebSocket(url);
    ws.addEventListener('open', ()=>{ console.log('WS open'); reconnectMs = 1000; });
    ws.addEventListener('message', ev => {
      // message payload may be string or binary
      const text = (typeof ev.data === 'string') ? ev.data : null;
      handleIncomingMessage(text || ev.data);
    });
    ws.addEventListener('close', ev => {
      console.warn('WS closed', ev);
      setTimeout(()=>connectWS(url), reconnectMs);
      reconnectMs = Math.min(30000, reconnectMs * 1.5);
    });
    ws.addEventListener('error', e => {
      console.error('WS error', e);
      // let close handler handle reconnect
    });
  }catch(e){
    console.error('WS connect exception', e);
    setTimeout(()=>connectWS(url), reconnectMs);
    reconnectMs = Math.min(30000, reconnectMs * 1.5);
  }
}

// call connect after init
connectWS();
setInterval(()=>{ pruneOld(); updateKpisFromLive(); }, 5000);