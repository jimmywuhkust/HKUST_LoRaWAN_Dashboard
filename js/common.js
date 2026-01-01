// common.js - shared code for the web app
// --- Small shared helpers (no Three.js here) ---
export async function fetchText(url){
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load ' + url);
  return await res.text();
}
export function parseCSV(text){
  const lines = text.split(/\r?\n/).filter(l=>l.trim().length>0);
  if (!lines.length) return [];
  const hdr = lines[0].split(',').map(h=>h.trim());
  const rows = [];
  for (let i=1;i<lines.length;i++){
    const raw = lines[i];
    if (!raw.trim()) continue;
    const cells = raw.split(',');
    const obj = {};
    for (let j=0;j<hdr.length && j<cells.length;j++) obj[hdr[j]] = cells[j];
    rows.push(obj);
  }
  return rows;
}
export function number(v, d=0){ const n = Number(String(v).replace(/[^0-9.\-]/g,'')); return isFinite(n) ? n : d; }
export function timeAgo(t){
  if(!t) return '-';
  const s = Math.max(0, (Date.now()-t)/1000|0);
  if(s<60) return s+"s"; const m=(s/60|0);
  if(m<60) return m+"m"; const h=(m/60|0);
  if(h<24) return h+"h"; return (h/24|0)+"d";
}
export function snrToPct(snr){
  if (snr == null || !isFinite(snr)) return 0;
  const pct = (snr + 15) / 27; // -15..+12 → 0..1
  return Math.max(0, Math.min(1, pct)) * 100;
}
export function rssiToPct(rssi){
  if (rssi == null || !isFinite(rssi)) return 0;
  const pct = ( -rssi - 125 ) / ( -40 - 125 ); // -125..-40 → 0..1
  return Math.max(0, Math.min(1, pct)) * 100;
}
export function snrCell(snr){
  const pct = snrToPct(Number(snr));
  const label = Number.isFinite(Number(snr)) ? Number(snr).toFixed(1) + ' dB' : '-';
  return `<div class="gcell"><div class="gbar"><div class="gfill" style="width:${pct}%"></div></div><div class="gval">${label}</div></div>`;
}
export function rssiCell(rssi){
  const pct = rssiToPct(Number(rssi));
  const label = Number.isFinite(Number(rssi)) ? `${rssi} dBm` : '-';
  return `<div class="gcell"><div class="gbar"><div class="gfill" style="width:${pct}%"></div></div><div class="gval">${label}</div></div>`;
}