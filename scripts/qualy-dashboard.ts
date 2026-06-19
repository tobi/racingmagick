import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { parsePds } from '../src/parsers/pds';

const root = '/home/tobi/src/tries/2026-06-18-intersting';
const files = [
  join(root, 'usb-interesting/pds/D2_Q1/Car14_#438/Offloaded/260610184326_26WEC01_R01_LM_Q1_Run001_TL_Car14_#438.pds'),
  join(root, 'usb-interesting/pds/D2_Q1/Car29_#725/Offloaded/260610184224_26WEC01_R01_LM_Q1_Run001_LR_Car29_#725.pds'),
];
const outDir = join(root, 'qualifying-dashboard');
mkdirSync(outDir, { recursive: true });

function fmtMs(ms:number){ if(!isFinite(ms)||ms<=0) return '—'; const s=ms/1000; const m=Math.floor(s/60); const r=s-m*60; return `${m}:${r.toFixed(3).padStart(6,'0')}`; }
function arrStats(a: Float64Array|null){ if(!a) return null; let min=Infinity,max=-Infinity,sum=0,n=0; for(const v of a){ if(Number.isFinite(v)){min=Math.min(min,v);max=Math.max(max,v);sum+=v;n++;}} return n?{min,max,avg:sum/n}:null; }
function toArray(a: Float64Array){ return Array.from(a, v => Number.isFinite(v) ? +v.toFixed(3) : null); }

const sessions = files.map(path => {
  console.error('Parsing', basename(path));
  const s = parsePds(new Uint8Array(readFileSync(path)), path);
  const fastest = s.fastestLap() ?? s.laps[0];
  const timed = s.timedLaps();
  const laps = s.laps.map(l => ({ label:l.displayLabel, kind:l.kind, lapTime:l.lapTime, lapTimeText:fmtMs(l.lapTime), distance:+l.totalDistance.toFixed(1), maxSpeed: arrStats(l.channel('speed'))?.max ?? null, avgThrottle: arrStats(l.channel('throttle'))?.avg ?? null }));
  const channels = ['speed','throttle','brakePressure','rpm','gear','steering','gpsLat','gpsLon'].filter(c => s.hasChannel(c));
  const traceLap = fastest;
  const trace:any = { position: Array.from({length:500},(_,i)=>+(i/499).toFixed(4)) };
  for (const ch of channels.filter(c => !['gpsLat','gpsLon'].includes(c))) trace[ch] = toArray(traceLap.channelAtPositions(ch,500));
  return {
    file: basename(path), driver: s.driver, vehicle: s.vehicle, track: s.track, date: s.date.toISOString(), sampleRate:s.sampleRate,
    lapCount:s.lapCount, duration:+s.totalDuration.toFixed(1), distance:+s.totalDistance.toFixed(1), channels:s.channelNames(), warnings:s.warnings,
    fastest: fastest ? { label:fastest.displayLabel, lapTime:fastest.lapTime, lapTimeText:fmtMs(fastest.lapTime), distance:+fastest.totalDistance.toFixed(1), maxSpeed: arrStats(fastest.channel('speed'))?.max ?? null } : null,
    laps, trace
  };
});

const dataPath = join(outDir, 'qualifying-data.json');
writeFileSync(dataPath, JSON.stringify({ generatedAt:new Date().toISOString(), sessions }, null, 2));

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Le Mans Qualifying Dashboard</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script><style>
body{margin:0;background:#0b0f14;color:#e8eef6;font-family:Inter,system-ui,Arial,sans-serif}.wrap{padding:24px;max-width:1400px;margin:auto}h1{margin:0 0 4px}.muted{color:#91a0b5}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:18px 0}.card{background:#121923;border:1px solid #263244;border-radius:14px;padding:16px}.big{font-size:30px;font-weight:800}.plots{display:grid;grid-template-columns:1fr;gap:16px}.plot{height:390px;background:#121923;border-radius:14px;border:1px solid #263244}table{width:100%;border-collapse:collapse;background:#121923;border-radius:14px;overflow:hidden}th,td{padding:9px 10px;border-bottom:1px solid #263244;text-align:left}th{color:#9fb0c8}code{color:#ffd166}</style></head><body><div class="wrap"><h1>Le Mans Q1 Telemetry Dashboard</h1><div class="muted">Built with racingmagick from Pi/Cosworth .pds qualifying offloads</div><div id="cards" class="grid"></div><div class="plots"><div id="speed" class="plot"></div><div id="inputs" class="plot"></div></div><h2>Laps</h2><div id="laps"></div><p class="muted">Source JSON: <code>qualifying-data.json</code></p></div><script>
const DATA=${JSON.stringify({ generatedAt:new Date().toISOString(), sessions })};
const colors=['#4cc9f0','#f72585','#ffd166','#06d6a0'];
document.getElementById('cards').innerHTML=DATA.sessions.map((s,i)=>'<div class="card"><div class="muted">'+s.vehicle+' / '+s.driver+'</div><div class="big">'+s.fastest.lapTimeText+'</div><div>Fastest '+s.fastest.label+'</div><div>Max '+(s.fastest.maxSpeed||0).toFixed(1)+' km/h</div><div class="muted">'+s.lapCount+' laps · '+s.sampleRate+' Hz</div></div>').join('');
Plotly.newPlot('speed', DATA.sessions.map((s,i)=>({x:s.trace.position,y:s.trace.speed,mode:'lines',name:s.vehicle+' '+s.driver, line:{color:colors[i]}})), {title:'Fastest lap speed vs track position',paper_bgcolor:'#121923',plot_bgcolor:'#0b0f14',font:{color:'#e8eef6'},xaxis:{title:'Track position'},yaxis:{title:'Speed km/h'}}, {responsive:true});
let traces=[]; DATA.sessions.forEach((s,i)=>{ if(s.trace.throttle) traces.push({x:s.trace.position,y:s.trace.throttle.map(v=>v*100),mode:'lines',name:s.vehicle+' throttle %',line:{color:colors[i]}}); if(s.trace.brakePressure) traces.push({x:s.trace.position,y:s.trace.brakePressure,mode:'lines',name:s.vehicle+' brake bar',line:{color:colors[i],dash:'dot'}}); });
Plotly.newPlot('inputs', traces, {title:'Driver inputs on fastest lap',paper_bgcolor:'#121923',plot_bgcolor:'#0b0f14',font:{color:'#e8eef6'},xaxis:{title:'Track position'},yaxis:{title:'Throttle % / brake bar'}}, {responsive:true});
document.getElementById('laps').innerHTML='<table><thead><tr><th>Car</th><th>Driver</th><th>Lap</th><th>Kind</th><th>Time</th><th>Distance</th><th>Max speed</th></tr></thead><tbody>'+DATA.sessions.flatMap(s=>s.laps.map(l=>'<tr><td>'+s.vehicle+'</td><td>'+s.driver+'</td><td>'+l.label+'</td><td>'+l.kind+'</td><td>'+l.lapTimeText+'</td><td>'+l.distance+' m</td><td>'+(l.maxSpeed?l.maxSpeed.toFixed(1):'—')+'</td></tr>')).join('')+'</tbody></table>';
</script></body></html>`;
writeFileSync(join(outDir, 'index.html'), html);
console.log('Wrote', join(outDir, 'index.html'));
