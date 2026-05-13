/* ============================================================
   CSE Auto-Invest Terminal — script.js v5.0
   Fixed cash tracking & auto engine persistence
============================================================ */

const PROXY = "http://18.142.230.245:5000";

/* ── Sampath Securities Fee Model ───────────────────────── */
const FEE_BROKERAGE  = 0.0050;
const FEE_SEC        = 0.0005;
const FEE_CSE        = 0.0007;
const FEE_DOIT       = 0.0004;
const FEE_ONE_SIDE   = FEE_BROKERAGE + FEE_SEC + FEE_CSE + FEE_DOIT;  // 0.0066
const FEE_ROUND_TRIP = FEE_ONE_SIDE * 2;                               // 0.0132

/* ── Signal Thresholds (defaults) ───────────────────────── */
const RSI_OVERSOLD     = 40;
const RSI_OVERBOUGHT   = 65;
const VOL_SPIKE_THRESH = 1.5;
const MA_PERIOD_SHORT  = 20;
const MA_PERIOD_LONG   = 50;
const TARGET_PCT       = 0.07;
const STOPLOSS_PCT     = 0.03;
const MIN_CANDLES      = 22;

/* ── Global State ───────────────────────────────────────── */
let BUDGET       = 100000;          // reference budget (user defined)
let autoCashBalance = BUDGET;       // REAL cash for auto engine
let currentPage  = 'summary';
let loaded       = {};
let allSymbols   = [];
let liveMarket   = [];
let scanResults  = [];
let scanFilter   = 'ALL';
let portfolio    = [];              // manual positions
let autoPortfolio = [];             // auto-invest positions
let tradeLog     = [];
let allocChart   = null;
let autoAllocChart = null;
let refreshTimer = null;
let autoEngineTimer = null;
let autoEngineRunning = false;
let pendingSellSymbol = null;

const histCache = {};
const CACHE_TTL = 4 * 60 * 60 * 1000;
const cacheTime = {};

/* ============================================================
   UTILITIES
============================================================ */
const fmt    = (n,d=2) => n==null||isNaN(n) ? '—' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtBig = n => { if(!n||isNaN(n))return'—'; n=Number(n); if(n>=1e9)return(n/1e9).toFixed(2)+'B'; if(n>=1e6)return(n/1e6).toFixed(2)+'M'; if(n>=1e3)return(n/1e3).toFixed(1)+'K'; return n.toLocaleString(); };
const sgn    = v => v > 0 ? '+' : '';
const cls    = v => v > 0 ? 'up' : v < 0 ? 'dn' : 'neutral';
const badge  = v => `<span class="badge ${v>0?'badge-up':'badge-dn'}">${sgn(v)}${fmt(v)}%</span>`;
const now    = () => new Date().toLocaleTimeString('en-US',{hour12:false});

const showErr = (id, msg) => { const e=document.getElementById(id); if(e){e.style.display='block';e.textContent='⚠ '+msg;} };
const hideErr = (id) => { const e=document.getElementById(id); if(e) e.style.display='none'; };
const setTime = () => {
  document.getElementById('last-update').textContent = 'Updated '+now();
  document.getElementById('sbLastRefresh').textContent = now();
};

const normalizeSymbol = raw => {
  const s = raw.trim().toUpperCase();
  if(s.includes('.')) return s;
  const exact = allSymbols.find(x=>x.toUpperCase()===s);
  if(exact) return exact;
  const starts = allSymbols.find(x=>x.toUpperCase().startsWith(s+'.'));
  return starts || s;
};

function showToast(msg, type='info', duration=4000) {
  let container = document.getElementById('toastContainer');
  if(!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(()=>t.remove(), 300); }, duration);
}

/* ============================================================
   CLOCK & MARKET STATUS
============================================================ */
setInterval(() => { document.getElementById('clockDisplay').textContent = now(); }, 1000);
document.getElementById('clockDisplay').textContent = now();

function getMarketStatus() {
  const n = new Date();
  const slt = new Date(n.getTime() + n.getTimezoneOffset()*60000 + 5.5*3600000);
  const day  = slt.getDay();
  const mins = slt.getHours()*60 + slt.getMinutes();
  const open=9*60+30, close=14*60+30;
  const weekday = day>=1&&day<=5;
  if(weekday && mins>=open && mins<close) return { label:'OPEN',   cls:'pill-open',   sub:'Closes 2:30 PM SLT' };
  if(weekday && mins<open)               return { label:'PRE',    cls:'pill-pre',    sub:'Opens 9:30 AM SLT' };
  return { label:'CLOSED', cls:'pill-closed', sub: day<5?'Opens tomorrow 9:30 AM':'Opens Monday 9:30 AM' };
}
function updateMarketStatusUI() {
  const s = getMarketStatus();
  const pill = document.getElementById('marketStatusPill');
  const sub  = document.getElementById('marketStatusSub');
  if(pill) { pill.textContent=s.label; pill.className='market-pill '+s.cls; }
  if(sub)  sub.textContent = s.sub;
}
setInterval(updateMarketStatusUI, 30000);
updateMarketStatusUI();

/* ============================================================
   API FETCH
============================================================ */
async function apiFetch(endpoint) {
  const r = await fetch(`${PROXY}/${endpoint}`);
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ============================================================
   TECHNICAL INDICATORS (unchanged)
============================================================ */
function calcRSI(closes, period=14) {
  if(!closes || closes.length < period+1) return null;
  const prices = closes.slice(-Math.max(period*3, 50));
  let gains=0, losses=0;
  for(let i=1;i<=period;i++) { const d=prices[i]-prices[i-1]; if(d>=0) gains+=d; else losses+=Math.abs(d); }
  let avgGain=gains/period, avgLoss=losses/period;
  for(let i=period+1;i<prices.length;i++) {
    const d=prices[i]-prices[i-1], g=d>=0?d:0, l=d<0?Math.abs(d):0;
    avgGain=(avgGain*(period-1)+g)/period; avgLoss=(avgLoss*(period-1)+l)/period;
  }
  if(avgLoss===0) return 100;
  return Math.round(100-(100/(1+avgGain/avgLoss)));
}

function calcSMA(closes, period) {
  if(!closes||closes.length<period) return null;
  return closes.slice(-period).reduce((a,b)=>a+b,0)/period;
}

function avgVolume(volumes, period=20) {
  if(!volumes||volumes.length<period) return null;
  return volumes.slice(-period).reduce((a,b)=>a+b,0)/period;
}

function detectSR(closes, lastPrice, lookback=30) {
  if(!closes||closes.length<lookback) return {nearSupport:false,nearResistance:false};
  const slice = closes.slice(-lookback);
  return {
    nearSupport:    lastPrice <= Math.min(...slice)*1.02,
    nearResistance: lastPrice >= Math.max(...slice)*0.98,
    localMin: Math.min(...slice), localMax: Math.max(...slice),
  };
}

function calcMomentum(closes, period=7) {
  if(!closes||closes.length<period) return null;
  const s = closes.slice(-period);
  return (s[s.length-1]-s[0])/s[0]*100;
}

function feeSummary(entryPrice) {
  const perSide = entryPrice * FEE_ONE_SIDE;
  const total   = perSide * 2;
  return { perSide, total, netTarget: entryPrice*TARGET_PCT - total, breakEvenPct: FEE_ROUND_TRIP*100 };
}

function calcFees(price, shares) {
  const value = price * shares;
  return { buy: value * FEE_ONE_SIDE, sell: value * FEE_ONE_SIDE, total: value * FEE_ROUND_TRIP };
}

async function fetchHistory(symbol) {
  const t = Date.now();
  if(histCache[symbol] && (t-cacheTime[symbol]) < CACHE_TTL) return histCache[symbol];
  try {
    const d = await fetch(`${PROXY}/historicalData?symbol=${encodeURIComponent(symbol)}&period=3M`).then(r=>r.json());
    if(d?.error) throw new Error(d.error);
    const candles = d?.candles ?? [];
    histCache[symbol] = candles; cacheTime[symbol] = t;
    return candles;
  } catch(e) { console.warn(`hist ${symbol}:`, e.message); return []; }
}

/* ============================================================
   SIGNAL ENGINE (unchanged)
============================================================ */
async function computeSignalFull(liveRow) {
  const { symbol, lastPrice, open, high, low, volume, turnover, changePct, prevClose, name } = liveRow;
  if(!lastPrice||lastPrice<=0) return null;

  const candles  = await fetchHistory(symbol);
  const closes   = candles.map(c=>c.close).filter(v=>v>0);
  const volumes  = candles.map(c=>c.volume);
  const hasHist  = closes.length >= MIN_CANDLES;

  const rsi      = hasHist ? calcRSI(closes)                     : null;
  const ma20     = hasHist ? calcSMA(closes, MA_PERIOD_SHORT)     : null;
  const ma50     = hasHist ? calcSMA(closes, MA_PERIOD_LONG)      : null;
  const avgVol20 = hasHist ? avgVolume(volumes, 20)              : null;
  const volRatio = (avgVol20&&avgVol20>0) ? volume/avgVol20      : null;
  const momentum = hasHist ? calcMomentum(closes, 7)             : null;
  const sr       = hasHist ? detectSR(closes, lastPrice)         : null;

  const fees        = feeSummary(lastPrice);
  const targetPrice = lastPrice * (1 + TARGET_PCT);
  const stopPrice   = lastPrice * (1 - STOPLOSS_PCT);

  let score = 0;
  const signals = [];

  if(rsi !== null) {
    if(rsi < 30)            { score += 1.5; signals.push(`RSI ${rsi} (deeply oversold)`); }
    else if(rsi < RSI_OVERSOLD) { score += 1; signals.push(`RSI ${rsi} (oversold)`); }
    else if(rsi > RSI_OVERBOUGHT){ score -= 0.5; signals.push(`RSI ${rsi} (overbought)`); }
    else                    { score += 0.3; signals.push(`RSI ${rsi}`); }
  } else { if(changePct>=1) score+=0.5; }

  if(ma20 !== null) { if(lastPrice>ma20){score+=0.75;signals.push('Above 20MA');}else{score-=0.25;signals.push('Below 20MA');} }
  if(ma50 !== null) { if(lastPrice>ma50){score+=0.75;signals.push('Above 50MA');}else signals.push('Below 50MA'); }

  if(volRatio !== null && volRatio >= VOL_SPIKE_THRESH) { score += 0.5; signals.push(`Vol spike ${volRatio.toFixed(1)}×`); }
  if(sr?.nearSupport)    { score += 0.3; signals.push('Near support'); }
  if(sr?.nearResistance) { score -= 0.3; signals.push('Near resistance'); }
  if(momentum !== null)  { if(momentum>2){score+=0.3;signals.push('Upward momentum');} else if(momentum<-2){score-=0.3;signals.push('Downward momentum');} }

  score = Math.max(0, Math.min(5, Math.round(score)));

  let signal = 'HOLD';
  if(score >= 3 && rsi !== null && rsi < RSI_OVERSOLD && fees.netTarget > 0) signal = 'BUY';
  else if(score >= 3 && fees.netTarget > 0 && changePct >= 0.5) signal = 'BUY';
  else if(score <= 1 || (rsi !== null && rsi > RSI_OVERBOUGHT)) signal = 'SELL';
  else if(score === 2) signal = 'WATCH';

  const reason = signals.slice(0,3).join(' · ') || (changePct>=0?'Positive momentum':'Negative momentum');

  return {
    symbol, name, lastPrice, open, high, low, volume, turnover, changePct, prevClose,
    rsi, ma20, ma50, volRatio, momentum, sr, hasHistory: hasHist,
    signal, score, reason, targetPrice, stopLossPrice: stopPrice,
    feePct: FEE_ROUND_TRIP*100, feeTotal: fees.total/Math.max(1,volume||1),
    netProfitTarget: fees.netTarget,
    holding: autoPortfolio.some(p=>p.symbol===symbol) || portfolio.some(p=>p.symbol===symbol),
  };
}

function computeSignalFast(liveRow) {
  const { symbol, lastPrice, changePct, volume, name } = liveRow;
  if(!lastPrice||lastPrice<=0) return null;
  let score = 0;
  if(changePct>2) score=3; else if(changePct>0.5) score=2; else if(changePct<-2) score=1;
  const signal = score>=3?'BUY':score<=1?'SELL':'WATCH';
  return { symbol, name, lastPrice, changePct, volume, signal, score, reason:'Intraday only', hasHistory:false, holding:false };
}

/* ============================================================
   TICKER TAPE & MARKET SUMMARY (unchanged except small fixes)
============================================================ */
function buildTape(data) {
  const items = (data||liveMarket||[]).slice(0,30).map(r => {
    const ch = r.changePct||r.percentageChange||0;
    return `<div class="tape-item">
      <span class="tape-ticker">${(r.symbol||'').split('.')[0]}</span>
      <span class="tape-price">LKR ${fmt(r.lastPrice||r.price)}</span>
      <span class="${ch>=0?'up':'dn'}">${ch>=0?'▲':'▼'} ${Math.abs(ch).toFixed(2)}%</span>
    </div>`;
  }).join('');
  const el = document.getElementById('tapeInner');
  if(el && items) el.innerHTML = items + items;
}

async function loadSummary() {
  if(loaded.summary) return;
  hideErr('summary-err');
  document.getElementById('active-loader').style.display = 'inline-block';
  try {
    const [summary, bulk] = await Promise.allSettled([
      apiFetch('dailyMarketSummery'),
      apiFetch('bulkScan'),
    ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : null));

    document.getElementById('proxy-status').textContent = '✓ Connected';

    const d = summary?.reqData?.[0]?.[0] || (Array.isArray(summary) ? summary[0] : summary);
    if(d) {
      const asiVal = d.asi||0, sptVal = d.spt||0;
      document.getElementById('m-aspi').textContent  = fmt(asiVal,2);
      document.getElementById('m-sl20').textContent  = fmt(sptVal,2);
      document.getElementById('m-turn').textContent  = fmtBig(d.marketTurnover||0);
      document.getElementById('m-vol').textContent   = fmtBig(d.volumeOfTurnOverNumber||0);
      document.getElementById('m-trades').textContent= fmtBig(d.marketTrades||0);
      document.getElementById('m-adv').textContent   = fmtBig(d.marketDomestic||0);
      document.getElementById('m-dec').textContent   = fmtBig(d.marketForeign||0);
      document.getElementById('m-unc').textContent   = d.tradeCompanyNumber||'—';
    }

    const arr = bulk?.data || [];
    liveMarket = arr;
    allSymbols = arr.map(r=>r.symbol).filter(Boolean).sort();
    buildTape(arr);
    setupAutocomplete();

    const sorted = [...arr].sort((a,b)=>(b.volume||0)-(a.volume||0)).slice(0,15);
    document.getElementById('active-body').innerHTML = sorted.map(r=>`
      <tr onclick="goLookup('${r.symbol}')" style="cursor:pointer">
        <td><strong style="font-family:var(--mono)">${r.symbol.split('.')[0]}</strong></td>
        <td style="font-family:var(--mono)">${fmt(r.lastPrice||0)}</td>
        <td>${badge(r.changePct||0)}</td>
        <td style="font-family:var(--mono)">${fmtBig(r.volume||0)}</td>
        <td style="font-family:var(--mono)">LKR ${fmtBig(r.turnover||0)}</td>
      </tr>`).join('');

    refreshPortfolioPrices();
    checkAutoSellsSilent();

    loaded.summary = true;
    setTime();
    document.getElementById('active-loader').style.display='none';
  } catch(e) {
    document.getElementById('active-loader').style.display='none';
    document.getElementById('proxy-status').textContent = '✗ Offline';
    showErr('summary-err', 'Cannot reach proxy. Run: python proxy.py');
    document.getElementById('active-body').innerHTML = '<tr><td colspan="5" class="empty">Proxy offline — python proxy.py</td></tr>';
  }
}

async function loadMovers() {
  if(loaded.movers) return;
  hideErr('movers-err');
  try {
    const d = await apiFetch('bulkScan');
    const arr = d?.data||[];
    const withChange = arr.filter(r=>r.lastPrice>0&&r.changePct!==0);
    const gainers = [...withChange].sort((a,b)=>(b.changePct||0)-(a.changePct||0)).slice(0,10);
    const losers  = [...withChange].sort((a,b)=>(a.changePct||0)-(b.changePct||0)).slice(0,10);
    const row = r => `<tr onclick="goLookup('${r.symbol}')" style="cursor:pointer">
      <td><strong style="font-family:var(--mono)">${r.symbol.split('.')[0]}</strong></td>
      <td style="font-family:var(--mono)">${fmt(r.lastPrice)}</td>
      <td>${badge(r.changePct||0)}</td>
    </tr>`;
    document.getElementById('gainers-body').innerHTML = gainers.length ? gainers.map(row).join('') : '<tr><td colspan="3" class="empty">None</td></tr>';
    document.getElementById('losers-body').innerHTML  = losers.length  ? losers.map(row).join('')  : '<tr><td colspan="3" class="empty">None</td></tr>';
    loaded.movers = true; setTime();
  } catch(e) {
    showErr('movers-err','Cannot reach proxy. Run: python proxy.py');
  }
}

function setupAutocomplete() {
  const input = document.getElementById('sym-input');
  const list  = document.getElementById('sym-suggestions');
  if(!input||!list) return;
  input.addEventListener('input', () => {
    const val = input.value.trim().toUpperCase();
    list.innerHTML=''; if(!val||val.length<2){list.style.display='none';return;}
    const matches = allSymbols.filter(s=>s.toUpperCase().includes(val)).slice(0,8);
    if(!matches.length){list.style.display='none';return;}
    matches.forEach(sym => {
      const li=document.createElement('li'); li.textContent=sym;
      li.onclick=()=>{input.value=sym;list.style.display='none';lookupStock();};
      list.appendChild(li);
    });
    list.style.display='block';
  });
  document.addEventListener('click',e=>{if(!input.contains(e.target)&&!list.contains(e.target))list.style.display='none';});
}

async function lookupStock() {
  const raw = document.getElementById('sym-input').value.trim();
  if(!raw) return;
  const sym = normalizeSymbol(raw);
  document.getElementById('sym-input').value = sym;
  hideErr('lookup-err');
  document.getElementById('result-card').style.display='none';
  try {
    const d = await fetch(`${PROXY}/companyInfoSummery?symbol=${encodeURIComponent(sym)}`).then(r=>r.json());
    if(d?.error) throw new Error(d.error);
    const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v??'—'; };
    set('r-sym',  d.symbol||sym);
    set('r-name', d.name||sym);
    const lp = d.lastTradedPrice||d.lastPrice||0;
    set('r-price', `LKR ${fmt(lp)}`);
    const ch=parseFloat(d.change||0), chp=parseFloat(d.changePercentage||0);
    const rch=document.getElementById('r-change');
    if(rch){rch.textContent=`${sgn(ch)}${fmt(ch)} (${sgn(chp)}${fmt(chp)}%)`;rch.className='result-change '+cls(chp);}
    set('r-open', fmt(d.open)); set('r-high', fmt(d.high)); set('r-low', fmt(d.low));
    set('r-vol',  fmtBig(d.volume)); set('r-mcap', d.marketCap?'LKR '+fmtBig(d.marketCap):'—');
    set('r-52h',  fmt(d['52WeekHigh'])); set('r-52l', fmt(d['52WeekLow']));
    set('r-pe',   fmt(d.previousClose));
    document.getElementById('result-card').style.display='block'; setTime();
  } catch(e) { showErr('lookup-err',`Could not find "${sym}". Try full symbol e.g. LOLC.N0000`); }
}

function goLookup(sym) {
  showPage('lookup', document.querySelector('.nav-item[onclick*="lookup"]'));
  document.getElementById('sym-input').value=sym;
  lookupStock();
}

async function loadAnnouncements() {
  if(loaded.announcements) return;
  hideErr('ann-err');
  try {
    const d = await apiFetch('approvedAnnouncement');
    const arr = d?.approvedAnnouncements??d?.reqData??d?.data??[];
    document.getElementById('ann-loader').style.display='none';
    if(!Array.isArray(arr)||!arr.length) throw new Error('No data');
    document.getElementById('ann-body').innerHTML = arr.slice(0,30).map(a=>{
      const sym = a.symbol||'', co = a.company||sym||'CSE';
      const click = sym?`onclick="goLookup('${sym}')" style="cursor:pointer"`: '';
      return `<div class="ann-item">
        <div class="ann-sym" ${click}>${sym||co}</div>
        <div><div class="ann-title">${co} — ${a.announcementCategory||a.remarks||'Announcement'}</div><div class="ann-date">${a.dateOfAnnouncement||''}</div></div>
      </div>`;
    }).join('');
    loaded.announcements=true; setTime();
  } catch(e) {
    document.getElementById('ann-loader').style.display='none';
    showErr('ann-err','Cannot reach proxy. Run: python proxy.py');
    document.getElementById('ann-body').innerHTML='<div class="empty">No announcements</div>';
  }
}

/* ============================================================
   SCAN ENGINE (unchanged)
============================================================ */
async function runScan() {
  const btn = document.getElementById('scanBtn');
  btn.disabled=true; btn.innerHTML='Scanning…';
  document.getElementById('scanProgressWrap').style.display='block';
  document.getElementById('scanFilterBar').style.display='none';
  document.getElementById('scanResults').innerHTML='';
  setProgress(5,'Fetching live market data…');

  try {
    const d   = await apiFetch('bulkScan');
    const arr = d?.data??[];
    if(!Array.isArray(arr)||!arr.length) throw new Error('No data from proxy');

    liveMarket = arr;
    allSymbols = arr.map(r=>r.symbol).filter(Boolean).sort();
    setProgress(15,`Live data: ${arr.length} companies. Fetching history…`);

    const active = arr.filter(r=>r.lastPrice>0&&(r.volume>0||r.turnover>0));
    const total  = active.length;
    const computed = [];
    const BATCH = 10;

    for(let i=0;i<total;i+=BATCH) {
      const batch = active.slice(i,i+BATCH);
      const pct   = Math.round(15+(i/total)*75);
      setProgress(pct,`Analysing ${i+1}–${Math.min(i+BATCH,total)} of ${total}…`);
      const results = await Promise.all(batch.map(row=>computeSignalFull(row)));
      results.filter(Boolean).forEach(r=>computed.push(r));
    }

    const inactiveSet = new Set(computed.map(r=>r.symbol));
    arr.filter(r=>!inactiveSet.has(r.symbol)&&r.lastPrice>0).map(computeSignalFast).filter(Boolean).forEach(r=>computed.push(r));

    const order = {BUY:0,WATCH:1,HOLD:2,SELL:3,SKIP:4};
    computed.sort((a,b)=>(order[a.signal]??5)-(order[b.signal]??5)||b.score-a.score);
    scanResults = computed;

    const buys   = computed.filter(r=>r.signal==='BUY').length;
    const sells  = computed.filter(r=>r.signal==='SELL').length;
    const watches= computed.filter(r=>r.signal==='WATCH'||r.signal==='HOLD').length;
    document.getElementById('sbBuyCount').textContent  = buys;
    document.getElementById('sbSellCount').textContent = sells;
    document.getElementById('sbScanned').textContent   = computed.length;
    document.getElementById('scan-buy-count').textContent   = buys;
    document.getElementById('scan-sell-count').textContent  = sells;
    document.getElementById('scan-watch-count').textContent = watches;
    document.getElementById('scan-total-count').textContent = computed.length;
    document.getElementById('scanNote').textContent = `Scanned at ${now()} · RSI/MA/Volume analysis`;

    setProgress(100,'Done!');
    setTimeout(() => {
      document.getElementById('scanProgressWrap').style.display='none';
      document.getElementById('scanFilterBar').style.display='flex';
      rerenderScanResults();
    }, 400);

    if(autoEngineRunning) runAutoInvestCycle();
    setTime();
  } catch(e) {
    setProgress(0,'Error: '+e.message);
    document.getElementById('scanResults').innerHTML=`<div class="empty-state" style="color:var(--red)">⚠ ${e.message}<br><br>Make sure proxy.py is running: <code>python proxy.py</code></div>`;
    document.getElementById('scanProgressWrap').style.display='none';
  } finally {
    btn.disabled=false;
    btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan Now';
  }
}

function setProgress(pct, label) {
  document.getElementById('scanProgressBar').style.width = pct+'%';
  document.getElementById('scanProgressLabel').textContent = label;
}

function filterScan(f, el) {
  scanFilter=f;
  document.querySelectorAll('.filter-pill').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  rerenderScanResults();
}

function calcShares(price) {
  if(!price||price<=0) return 0;
  return Math.floor((autoCashBalance * 0.1) / price);
}

function rerenderScanResults() {
  if(!scanResults.length) return;
  const minScore = parseInt(document.getElementById('minScore')?.value||1);
  const showBuy  = document.getElementById('tog-buy')  ?.classList.contains('on');
  const showSell = document.getElementById('tog-sell') ?.classList.contains('on');
  const showWatch= document.getElementById('tog-watch')?.classList.contains('on');

  const filtered = scanResults.filter(r => {
    if(r.score<minScore) return false;
    if(scanFilter!=='ALL'&&r.signal!==scanFilter) return false;
    if(r.signal==='BUY'  && !showBuy)   return false;
    if(r.signal==='SELL' && !showSell)  return false;
    if((r.signal==='WATCH'||r.signal==='HOLD') && !showWatch) return false;
    return true;
  });

  if(!filtered.length) { document.getElementById('scanResults').innerHTML='<div class="empty-state">No signals match the current filter.</div>'; return; }

  document.getElementById('scanResults').innerHTML = filtered.map(r => {
    const sclass = r.signal==='BUY'?'buy':r.signal==='SELL'?'sell':r.signal==='HOLD'?'hold':'watch';
    const bclass = r.signal==='BUY'?'badge-buy':r.signal==='SELL'?'badge-sell':r.signal==='HOLD'?'badge-hold':'badge-watch';
    const dotC   = r.signal==='BUY'?'on-green':r.signal==='SELL'?'on-red':'on-blue';
    const dots   = Array.from({length:5},(_,i)=>`<div class="dot ${i<r.score?dotC:''}"></div>`).join('');
    const holdTag= r.holding?'<span class="holding-tag">HOLDING</span>':'';
    const noHist = !r.hasHistory?'<span class="no-hist-tag">INTRADAY</span>':'';
    const inAuto = autoPortfolio.some(p=>p.symbol===r.symbol);

    const targetBlock = r.signal==='BUY' ? `
      <div class="sc-targets">
        <div class="sc-target-row"><span class="sc-target-label">Target</span><span class="sc-target-val up">LKR ${fmt(r.targetPrice)} <span class="sc-target-pct">(+${(TARGET_PCT*100).toFixed(0)}%)</span></span></div>
        <div class="sc-target-row"><span class="sc-target-label">Stop loss</span><span class="sc-target-val dn">LKR ${fmt(r.stopLossPrice)} <span class="sc-target-pct">(-${(STOPLOSS_PCT*100).toFixed(0)}%)</span></span></div>
        <div class="sc-target-row"><span class="sc-target-label">Net profit/sh</span><span class="sc-target-val ${r.netProfitTarget>0?'up':'dn'}">LKR ${fmt(r.netProfitTarget)} after fees</span></div>
      </div>` : '';

    const indRow = `<div class="sc-indicators">
      ${r.rsi!=null?`<span class="ind-pill ${r.rsi<RSI_OVERSOLD?'ind-green':r.rsi>RSI_OVERBOUGHT?'ind-red':'ind-neutral'}">RSI ${r.rsi}</span>`:''}
      ${r.ma20!=null?`<span class="ind-pill ${r.lastPrice>r.ma20?'ind-green':'ind-red'}">20MA ${r.lastPrice>r.ma20?'▲':'▼'}</span>`:''}
      ${r.ma50!=null?`<span class="ind-pill ${r.lastPrice>r.ma50?'ind-green':'ind-red'}">50MA ${r.lastPrice>r.ma50?'▲':'▼'}</span>`:''}
      ${r.volRatio!=null?`<span class="ind-pill ${r.volRatio>=VOL_SPIKE_THRESH?'ind-amber':'ind-neutral'}">Vol ${r.volRatio.toFixed(1)}×</span>`:''}
    </div>`;

    return `<div class="signal-card ${sclass}" onclick="openDetailModal('${r.symbol}')">
      <div>
        <div class="sc-ticker">${r.symbol.split('.')[0]}${holdTag}${noHist}</div>
        <div class="sc-name">${r.name||r.symbol}</div>
        <div class="sc-sector">&nbsp;</div>
      </div>
      <div class="sc-mid">
        <div class="sc-signal-row"><span class="signal-badge ${bclass}">${r.signal}</span><div class="strength-dots">${dots}</div></div>
        <div class="sc-reason">${r.reason}</div>
        ${indRow}
        ${targetBlock}
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;align-items:center">
        <div style="font-family:var(--mono);font-size:10px;color:var(--text2)">Score</div>
        <div style="font-family:var(--mono);font-size:16px;font-weight:600;color:${r.signal==='BUY'?'var(--green)':r.signal==='SELL'?'var(--red)':'var(--blue)'}">${r.score}/5</div>
      </div>
      <div class="sc-price">
        <div class="price">LKR ${fmt(r.lastPrice)}</div>
        <div class="change ${r.changePct>=0?'up':'dn'}">${sgn(r.changePct)}${fmt(r.changePct)}%</div>
        <div class="vol">Vol ${fmtBig(r.volume)}</div>
        <div class="live-tag">● LIVE</div>
      </div>
      <div class="sc-alloc">
        ${r.signal==='BUY'?`<div class="shares">${calcShares(r.lastPrice)} sh</div><div class="cost">@ LKR ${fmt(r.lastPrice)}</div><div class="rupees">≈ LKR ${(calcShares(r.lastPrice)*r.lastPrice).toFixed(0)}</div>`:'<div class="cost" style="color:var(--text2);font-size:11px">—</div>'}
        <button class="add-pos-btn" onclick="event.stopPropagation();quickAdd('${r.symbol}',${r.lastPrice})">${r.holding?'Update':'+ Add'}</button>
        ${r.signal==='BUY'&&!inAuto?`<button class="add-pos-btn" style="margin-top:3px;color:var(--green);border-color:rgba(62,207,114,0.3)" onclick="event.stopPropagation();directAutoInvest('${r.symbol}',${r.lastPrice},'${(r.name||r.symbol).replace(/'/g,"\\'")}',${r.score})">⚡ Auto</button>`:''}
      </div>
    </div>`;
  }).join('');
}

function exportScanCSV() {
  if(!scanResults.length) return;
  const rows=[['Symbol','Name','Signal','Score','LastPrice','Change%','Volume','RSI','MA20','MA50','Target','StopLoss','NetProfitPerShare','Reason']];
  scanResults.forEach(r=>rows.push([r.symbol,r.name,r.signal,r.score,r.lastPrice,r.changePct,r.volume,r.rsi??'',r.ma20?.toFixed(2)??'',r.ma50?.toFixed(2)??'',r.targetPrice?.toFixed(2)??'',r.stopLossPrice?.toFixed(2)??'',r.netProfitTarget?.toFixed(2)??'',`"${r.reason}"`]));
  downloadCSV(rows, `cse-scan-${new Date().toISOString().slice(0,10)}.csv`);
}

/* ============================================================
   AUTO-INVEST ENGINE WITH CASH TRACKING
============================================================ */
function getAutoSettings() {
  return {
    tradeSize: parseFloat(document.getElementById('autoTradeSize').value)||10000,
    targetPct: parseFloat(document.getElementById('autoTargetPct').value)/100||0.07,
    stopPct:   parseFloat(document.getElementById('autoStopPct').value)/100||0.03,
    minScore:  parseInt(document.getElementById('autoMinScore').value)||3,
    maxPos:    parseInt(document.getElementById('autoMaxPos').value)||5,
  };
}

function toggleAutoEngine() {
  autoEngineRunning = !autoEngineRunning;
  const btn = document.getElementById('autoEngineBtn');
  const dot = document.getElementById('autoStatusDot');
  const msg = document.getElementById('autoStatusMsg');

  if(autoEngineRunning) {
    btn.className = 'auto-toggle-btn running';
    document.getElementById('autoEngineBtnLabel').textContent = '■ Stop Auto-Invest';
    dot.className = 'auto-status-dot running';
    msg.textContent = 'Engine running — monitoring signals every 60s…';
    showToast('Auto-Invest Engine started', 'buy');
    if(scanResults.length) runAutoInvestCycle();
    else runScan();
    autoEngineTimer = setInterval(() => {
      msg.textContent = `Engine running — last check ${now()}`;
      loaded = {};
      loadSummary().then(() => { if(scanResults.length) runAutoInvestCycle(); });
    }, 60000);
  } else {
    clearInterval(autoEngineTimer);
    btn.className = 'auto-toggle-btn';
    document.getElementById('autoEngineBtnLabel').textContent = '▶ Start Auto-Invest';
    dot.className = 'auto-status-dot';
    msg.textContent = 'Engine stopped.';
    showToast('Auto-Invest Engine stopped', 'info');
  }
}

function runAutoInvestCycle() {
  const cfg = getAutoSettings();
  const msg = document.getElementById('autoStatusMsg');
  let bought=0, skipped=0;

  const buyCandidates = scanResults.filter(r =>
    r.signal==='BUY' &&
    r.score >= cfg.minScore &&
    r.netProfitTarget > 0 &&
    !autoPortfolio.some(p=>p.symbol===r.symbol)
  );

  for(const r of buyCandidates) {
    if(autoPortfolio.length >= cfg.maxPos) break;
    // Use real autoCashBalance instead of BUDGET - totalCost
    const allocAmount = Math.min(cfg.tradeSize, autoCashBalance);
    if(allocAmount < cfg.tradeSize * 0.5) { skipped++; continue; }
    const shares = Math.floor(allocAmount / r.lastPrice);
    if(shares < 1) { skipped++; continue; }
    executeAutoBuy(r, shares, r.lastPrice, cfg);
    bought++;
  }

  msg.textContent = `Last cycle ${now()} — bought ${bought}, skipped ${skipped}, cash: LKR ${fmt(autoCashBalance,0)}`;
  renderAutoPortfolio();
  updateBudgetBar();
  document.getElementById('sbAutoCount').textContent = autoPortfolio.length;
}

function executeAutoBuy(r, shares, price, cfg) {
  const costWithFees = shares * price * (1 + FEE_ONE_SIDE);
  if(autoCashBalance < costWithFees) {
    showToast(`Insufficient cash (${fmt(autoCashBalance,0)}) for ${r.symbol}`, 'info');
    return;
  }

  const targetPrice = price * (1 + (cfg?.targetPct||TARGET_PCT));
  const stopPrice   = price * (1 - (cfg?.stopPct||STOPLOSS_PCT));
  const pos = {
    symbol:      r.symbol,
    name:        r.name || r.symbol,
    shares,
    buyPrice:    price,
    livePrice:   price,
    targetPrice,
    stopPrice,
    score:       r.score,
    reason:      r.reason,
    buyTime:     now(),
    changePct:   r.changePct||0,
  };
  autoPortfolio.push(pos);
  autoCashBalance -= costWithFees;
  saveAutoPortfolio();
  logTrade('BUY', pos.symbol, pos.name, shares, price, r.reason, null);
  showToast(`⚡ AUTO BUY: ${pos.symbol.split('.')[0]} — ${shares} shares @ LKR ${fmt(price)} | Cash: LKR ${fmt(autoCashBalance,0)}`, 'buy');
}

function directAutoInvest(symbol, price, name, score) {
  const cfg    = getAutoSettings();
  const shares = Math.floor(cfg.tradeSize / price);
  if(shares < 1) { showToast('Trade size too small for this price', 'info'); return; }
  if(autoPortfolio.some(p=>p.symbol===symbol)) { showToast('Already holding '+symbol, 'info'); return; }
  if(autoPortfolio.length >= cfg.maxPos) { showToast('Max positions reached ('+cfg.maxPos+')', 'info'); return; }
  const r = { symbol, name, score, lastPrice:price, reason:'Manual trigger from scan', changePct:0 };
  executeAutoBuy(r, shares, price, cfg);
  renderAutoPortfolio();
  updateBudgetBar();
  document.getElementById('sbAutoCount').textContent = autoPortfolio.length;
}

function autoInvestFromModal() {
  const symbol = _modalSymbol;
  if(!symbol) { showToast('No stock selected', 'info'); return; }

  let row = scanResults.find(r => r.symbol === symbol);
  if(!row) {
    const live = liveMarket.find(r => r.symbol === symbol);
    if(!live) { showToast('Run a scan first to get full signal data', 'info'); return; }
    row = { symbol: live.symbol, name: live.name || live.symbol, lastPrice: live.lastPrice, score: 0, reason: 'Manual from modal (no scan)', changePct: live.changePct || 0 };
  }

  directAutoInvest(row.symbol, row.lastPrice, row.name, row.score);
  closeModal();
}

function checkAutoSells() {
  refreshAutoPortfolioPrices();
  const cfg = getAutoSettings();
  let soldAny = false;
  const toSell = autoPortfolio.filter(p => {
    const retPct = (p.livePrice - p.buyPrice)/p.buyPrice;
    return retPct >= cfg.targetPct || retPct <= -cfg.stopPct;
  });
  if(!toSell.length) { showToast('No exit conditions triggered', 'info'); return; }
  toSell.forEach(p => { soldAny=true; executeAutoSell(p, p.livePrice, (p.livePrice-p.buyPrice)/p.buyPrice>=cfg.targetPct?'Target reached':'Stop loss hit'); });
  if(soldAny) { renderAutoPortfolio(); updateBudgetBar(); document.getElementById('sbAutoCount').textContent=autoPortfolio.length; }
}

function checkAutoSellsSilent() {
  if(!autoPortfolio.length) return;
  refreshAutoPortfolioPrices();
  const cfg = getAutoSettings();
  const toSell = autoPortfolio.filter(p => {
    const retPct = (p.livePrice - p.buyPrice)/p.buyPrice;
    return retPct >= cfg.targetPct || retPct <= -cfg.stopPct;
  });
  toSell.forEach(p => {
    const retPct = (p.livePrice - p.buyPrice)/p.buyPrice;
    executeAutoSell(p, p.livePrice, retPct >= cfg.targetPct ? 'Target reached' : 'Stop loss hit');
  });
  if(toSell.length) { renderAutoPortfolio(); updateBudgetBar(); document.getElementById('sbAutoCount').textContent=autoPortfolio.length; }
}

function executeAutoSell(pos, sellPrice, reason) {
  const netProceeds = pos.shares * sellPrice * (1 - FEE_ONE_SIDE);
  const invested = pos.shares * pos.buyPrice;
  const grossPnl = (pos.shares * sellPrice) - invested;
  const fees = (pos.shares * pos.buyPrice * FEE_ONE_SIDE) + (pos.shares * sellPrice * FEE_ONE_SIDE);
  const netPnl = grossPnl - fees;

  autoPortfolio = autoPortfolio.filter(p=>p.symbol!==pos.symbol);
  autoCashBalance += netProceeds;
  saveAutoPortfolio();

  logTrade('SELL', pos.symbol, pos.name, pos.shares, sellPrice, reason, netPnl);
  const type = netPnl >= 0 ? 'buy' : 'sell';
  showToast(`⚡ AUTO SELL: ${pos.symbol.split('.')[0]} — ${pos.shares} sh @ LKR ${fmt(sellPrice)} | Net P&L: ${netPnl>=0?'+':''}LKR ${fmt(Math.abs(netPnl))} | Cash: LKR ${fmt(autoCashBalance,0)}`, type, 6000);
}

function triggerManualSell(symbol) {
  const pos = autoPortfolio.find(p=>p.symbol===symbol);
  if(!pos) return;
  pendingSellSymbol = symbol;
  const live   = liveMarket.find(r=>r.symbol===symbol);
  const sp     = live?.lastPrice || pos.livePrice;
  const invested = pos.shares*pos.buyPrice, proceeds=pos.shares*sp;
  const gross  = proceeds-invested, fees=(invested+proceeds)*FEE_ONE_SIDE, net=gross-fees;
  document.getElementById('sellModalTitle').textContent = `Sell ${symbol.split('.')[0]}`;
  document.getElementById('sellModalSub').textContent   = pos.name;
  document.getElementById('sellModalBody').innerHTML    = `
    <div class="modal-section-title">Trade Summary</div>
    <div class="modal-row"><span class="mk">Shares</span><span class="mv">${pos.shares}</span></div>
    <div class="modal-row"><span class="mk">Buy Price</span><span class="mv">LKR ${fmt(pos.buyPrice)}</span></div>
    <div class="modal-row"><span class="mk">Sell Price</span><span class="mv">LKR ${fmt(sp)}</span></div>
    <div class="modal-row"><span class="mk">Gross P&amp;L</span><span class="mv ${gross>=0?'up':'dn'}">${gross>=0?'+':''}LKR ${fmt(gross)}</span></div>
    <div class="modal-row"><span class="mk">Est. Fees</span><span class="mv neutral">LKR ${fmt(fees)}</span></div>
    <div class="modal-row"><span class="mk">Net P&amp;L</span><span class="mv ${net>=0?'up':'dn'}" style="font-size:15px;font-weight:600">${net>=0?'+':''}LKR ${fmt(net)}</span></div>
  `;
  document.getElementById('sellModal').classList.add('open');
}

function confirmSell() {
  if(!pendingSellSymbol) return;
  const pos  = autoPortfolio.find(p=>p.symbol===pendingSellSymbol);
  if(!pos) { closeSellModal(); return; }
  const live = liveMarket.find(r=>r.symbol===pendingSellSymbol);
  const sp   = live?.lastPrice || pos.livePrice;
  executeAutoSell(pos, sp, 'Manual sell');
  renderAutoPortfolio(); updateBudgetBar();
  document.getElementById('sbAutoCount').textContent = autoPortfolio.length;
  closeSellModal();
}
function closeSellModal() { pendingSellSymbol=null; document.getElementById('sellModal').classList.remove('open'); }

function refreshAutoPortfolioPrices() {
  if(!liveMarket.length) return;
  autoPortfolio = autoPortfolio.map(p => {
    const live = liveMarket.find(r=>r.symbol===p.symbol||r.symbol.startsWith(p.symbol.split('.')[0]+'.'));
    return live ? {...p, livePrice:live.lastPrice, changePct:live.changePct||0} : p;
  });
  saveAutoPortfolio();
}

function renderAutoPortfolio() {
  refreshAutoPortfolioPrices();
  const tbody = document.getElementById('autoPortfolioBody');
  if(!autoPortfolio.length) {
    document.getElementById('autoAllocCard').style.display='none';
    tbody.innerHTML='<tr><td colspan="14" class="empty">No auto positions. Start the engine or click ⚡ Auto on a BUY signal.</td></tr>';
    document.getElementById('autoMetrics').innerHTML='';
    return;
  }

  const totalInv  = autoPortfolio.reduce((a,p)=>a+p.shares*p.buyPrice,0);
  const totalVal  = autoPortfolio.reduce((a,p)=>a+p.shares*p.livePrice,0);
  const grossPnl  = totalVal-totalInv;
  const totalFees = autoPortfolio.reduce((a,p)=>(a+(p.shares*p.buyPrice+p.shares*p.livePrice)*FEE_ONE_SIDE),0);
  const netPnl    = grossPnl-totalFees;
  const netPct    = totalInv>0?(netPnl/totalInv*100).toFixed(2):'0';

  const metrics = [
    {label:'Auto Portfolio Value', val:`LKR ${fmt(totalVal,0)}`, sub:`${grossPnl>=0?'+':''}${(totalInv>0?(grossPnl/totalInv*100).toFixed(2):'0')}% gross`, cls:grossPnl>=0?'up':'dn'},
    {label:'Total Auto Invested',  val:`LKR ${fmt(totalInv,0)}`, sub:`${autoPortfolio.length} auto positions`, cls:'neutral'},
    {label:'Net P&L (after fees)', val:`${netPnl>=0?'+':''}LKR ${fmt(Math.abs(netPnl),0)}`, sub:`${netPct>=0?'+':''}${netPct}% net`, cls:netPnl>=0?'up':'dn'},
    {label:'Auto Cash Available',   val:`LKR ${fmt(autoCashBalance,0)}`, sub:'Real cash after fees', cls:'neutral'},
  ];
  document.getElementById('autoMetrics').innerHTML = metrics.map(c=>`<div class="metric-cell">
    <div class="metric-label">${c.label}</div><div class="metric-value">${c.val}</div><div class="metric-sub ${c.cls}">${c.sub}</div>
  </div>`).join('');

  tbody.innerHTML = autoPortfolio.map(p => {
    const invested = p.shares*p.buyPrice, curVal=p.shares*p.livePrice;
    const gross    = curVal-invested;
    const fees     = (invested+curVal)*FEE_ONE_SIDE;
    const net      = gross-fees;
    const ret      = invested>0?(gross/invested*100).toFixed(2):'0';
    const retPct   = (p.livePrice-p.buyPrice)/p.buyPrice*100;
    const pc       = gross>=0?'var(--green)':'var(--red)';
    const nc       = net>=0?'var(--green)':'var(--red)';
    const atTarget = retPct >= (parseFloat(document.getElementById('autoTargetPct').value)||7);
    const atStop   = retPct <= -(parseFloat(document.getElementById('autoStopPct').value)||3);
    const exitTag  = atTarget?'<span style="font-size:9px;background:var(--green-dim);color:var(--green);border-radius:3px;padding:1px 5px;margin-left:4px">TARGET</span>':atStop?'<span style="font-size:9px;background:var(--red-dim);color:var(--red);border-radius:3px;padding:1px 5px;margin-left:4px">STOP</span>':'';
    const scanRow  = scanResults.find(r=>r.symbol===p.symbol);
    const sigBadge = scanRow?`<span class="signal-badge badge-${scanRow.signal.toLowerCase()}">${scanRow.signal}</span>`:'—';
    return `<tr>
      <td><strong style="font-family:var(--mono)">${p.symbol.split('.')[0]}</strong>${exitTag}</td>
      <td style="color:var(--text2);font-size:11px">${p.name}</td>
      <td style="text-align:right;font-family:var(--mono)">${p.shares}</td>
      <td style="text-align:right;font-family:var(--mono)">${fmt(p.buyPrice)}</td>
      <td style="text-align:right;font-family:var(--mono)">${fmt(p.livePrice)}</td>
      <td style="text-align:right;font-family:var(--mono)">${fmtBig(invested)}</td>
      <td style="text-align:right;font-family:var(--mono)">${fmtBig(curVal)}</td>
      <td style="text-align:right;font-family:var(--mono);color:${pc}">${gross>=0?'+':''}${fmtBig(gross)}</td>
      <td style="text-align:right;font-family:var(--mono);color:${nc}" title="After fees">${net>=0?'+':''}${fmtBig(net)}</td>
      <td style="text-align:right;font-family:var(--mono);color:${pc}">${gross>=0?'+':''}${ret}%</td>
      <td style="text-align:right;font-family:var(--mono);color:var(--green)">${fmt(p.targetPrice)}</td>
      <td style="text-align:right;font-family:var(--mono);color:var(--red)">${fmt(p.stopPrice)}</td>
      <td style="text-align:right">${sigBadge}</td>
      <td style="text-align:right">
        <button onclick="triggerManualSell('${p.symbol}')" style="font-size:10px;padding:3px 8px;background:var(--red-dim);border:1px solid rgba(240,79,79,0.2);color:var(--red);border-radius:4px;cursor:pointer;font-family:var(--mono)">SELL</button>
      </td>
    </table>`;
  }).join('');

  renderAutoAllocChart();
  document.getElementById('autoAllocCard').style.display = 'block';
}

function renderAutoAllocChart() {
  const el = document.getElementById('autoAllocChart');
  if(!el||!autoPortfolio.length) return;
  if(autoAllocChart) autoAllocChart.destroy();
  const colors=['#3ecf72','#4d9cf5','#f5a623','#f04f4f','#a78bfa','#34d399','#fb7185','#60a5fa','#fbbf24','#a3e635'];
  autoAllocChart = new Chart(el,{
    type:'doughnut',
    data:{labels:autoPortfolio.map(p=>p.symbol.split('.')[0]),datasets:[{data:autoPortfolio.map(p=>p.shares*p.buyPrice),backgroundColor:autoPortfolio.map((_,i)=>colors[i%colors.length]),borderWidth:0,hoverOffset:4}]},
    options:{responsive:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: LKR ${ctx.parsed.toFixed(0)}`}}},cutout:'68%'}
  });
  const legend = document.getElementById('autoAllocLegend');
  if(legend) legend.innerHTML = autoPortfolio.map((p,i)=>`<div class="alloc-row">
    <div class="alloc-swatch" style="background:${colors[i%colors.length]}"></div>
    <span class="alloc-ticker">${p.symbol.split('.')[0]}</span>
    <span class="alloc-lkr">LKR ${(p.shares*p.buyPrice).toFixed(0)}</span>
    <span style="font-family:var(--mono);font-size:10px;color:${(p.livePrice-p.buyPrice)>=0?'var(--green)':'var(--red)'};">${(p.livePrice-p.buyPrice)>=0?'+':''}${((p.livePrice-p.buyPrice)/p.buyPrice*100).toFixed(2)}%</span>
  </div>`).join('');
}

/* ── localStorage persistence (including cash balance) ─── */
function saveAutoPortfolio() {
  localStorage.setItem('cse_auto_portfolio', JSON.stringify(autoPortfolio));
  localStorage.setItem('cse_auto_cash', autoCashBalance.toString());
}
function loadAutoPortfolio() {
  try { autoPortfolio = JSON.parse(localStorage.getItem('cse_auto_portfolio')||'[]'); } catch{ autoPortfolio=[]; }
  const savedCash = localStorage.getItem('cse_auto_cash');
  if(savedCash !== null && !isNaN(parseFloat(savedCash))) autoCashBalance = parseFloat(savedCash);
  else autoCashBalance = BUDGET;
}

/* ============================================================
   TRADE LOG (unchanged)
============================================================ */
function logTrade(action, symbol, name, shares, price, reason, netPnl) {
  tradeLog.unshift({ time:now(), date:new Date().toLocaleDateString(), action, symbol, name, shares, price, value:shares*price, reason, netPnl });
  saveTradeLog();
  if(currentPage==='log') renderTradeLog();
}

function renderTradeLog() {
  const tbody = document.getElementById('tradeLogBody');
  if(!tradeLog.length) { tbody.innerHTML='<tr><td colspan="8" class="empty">No trades yet.</td></tr>'; return; }
  tbody.innerHTML = tradeLog.map(t=>{
    const color = t.action==='BUY'?'var(--green)':'var(--red)';
    const netCol = t.netPnl===null?'—':((t.netPnl>=0?'+':'')+'LKR '+fmt(Math.abs(t.netPnl)));
    const netCls = t.netPnl===null?'':t.netPnl>=0?'color:var(--green)':'color:var(--red)';
    return `<tr>
      <td style="font-family:var(--mono);font-size:11px;color:var(--text2)">${t.date} ${t.time}</td>
      <td><strong style="font-family:var(--mono)">${t.symbol.split('.')[0]}</strong><br><span style="color:var(--text2);font-size:10px">${t.name}</span></td>
      <td><span class="signal-badge ${t.action==='BUY'?'badge-buy':'badge-sell'}">${t.action}</span></td>
      <td style="font-family:var(--mono);text-align:right">${t.shares}</td>
      <td style="font-family:var(--mono);text-align:right">${fmt(t.price)}</td>
      <td style="font-family:var(--mono);text-align:right">LKR ${fmtBig(t.value)}</td>
      <td style="font-size:11px;color:var(--text2);max-width:200px">${t.reason}</td>
      <td style="font-family:var(--mono);text-align:right;${netCls}">${netCol}</td>
    </tr>`;
  }).join('');
}

function clearTradeLog() {
  if(!confirm('Clear all trade log entries?')) return;
  tradeLog=[]; saveTradeLog(); renderTradeLog();
}

function exportTradeLogCSV() {
  if(!tradeLog.length) return;
  const rows=[['Date','Time','Symbol','Action','Shares','Price','Value','Reason','NetPnL']];
  tradeLog.forEach(t=>rows.push([t.date,t.time,t.symbol,t.action,t.shares,t.price,t.value,`"${t.reason}"`,t.netPnl??'']));
  downloadCSV(rows, `cse-tradelog-${new Date().toISOString().slice(0,10)}.csv`);
}

function saveTradeLog() { localStorage.setItem('cse_trade_log', JSON.stringify(tradeLog.slice(0,500))); }
function loadTradeLog() { try{ tradeLog=JSON.parse(localStorage.getItem('cse_trade_log')||'[]'); }catch{ tradeLog=[]; } }

/* ============================================================
   MANUAL PORTFOLIO (unchanged)
============================================================ */
function loadPortfolioFromStorage() { try{ portfolio=JSON.parse(localStorage.getItem('cse_portfolio')||'[]'); }catch{ portfolio=[]; } }
function savePortfolioToStorage()   { localStorage.setItem('cse_portfolio', JSON.stringify(portfolio)); }

function openAddPosition() {
  ['add-symbol','add-shares','add-price'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('add-error').style.display='none';
  document.getElementById('addModal').classList.add('open');
}
function closeAddModal() { document.getElementById('addModal').classList.remove('open'); }
document.getElementById('addModal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeAddModal(); });

function quickAdd(symbol, price) {
  document.getElementById('add-symbol').value=symbol;
  document.getElementById('add-price').value=price;
  document.getElementById('add-shares').value='';
  document.getElementById('add-error').style.display='none';
  document.getElementById('addModal').classList.add('open');
}

function savePosition() {
  const symbol   = document.getElementById('add-symbol').value.trim().toUpperCase();
  const shares   = parseInt(document.getElementById('add-shares').value);
  const buyPrice = parseFloat(document.getElementById('add-price').value);
  const errEl    = document.getElementById('add-error');
  if(!symbol)              { errEl.textContent='Symbol is required';            errEl.style.display='block'; return; }
  if(!shares||shares<1)   { errEl.textContent='Enter a valid number of shares'; errEl.style.display='block'; return; }
  if(!buyPrice||buyPrice<=0){ errEl.textContent='Enter a valid buy price';       errEl.style.display='block'; return; }
  const live = liveMarket.find(r=>r.symbol===symbol||r.symbol.startsWith(symbol.split('.')[0]+'.'));
  const pos  = { symbol, name:live?.name||symbol, shares, buyPrice, livePrice:live?.lastPrice||buyPrice, changePct:live?.changePct||0 };
  const idx  = portfolio.findIndex(p=>p.symbol===symbol);
  if(idx>=0) portfolio[idx]=pos; else portfolio.push(pos);
  savePortfolioToStorage();
  closeAddModal();
  renderPortfolio();
}

function removePosition(symbol) {
  portfolio = portfolio.filter(p=>p.symbol!==symbol);
  savePortfolioToStorage();
  renderPortfolio();
}

function refreshPortfolioPrices() {
  if(!liveMarket.length) return;
  portfolio = portfolio.map(p=>{
    const live = liveMarket.find(r=>r.symbol===p.symbol||r.symbol.startsWith(p.symbol.split('.')[0]+'.'));
    return live ? {...p, livePrice:live.lastPrice, changePct:live.changePct||0} : p;
  });
  savePortfolioToStorage();
  if(currentPage==='portfolio') renderPortfolio();
  if(currentPage==='pnl') renderPnlTable();
  updateBudgetBar();
}

function refreshPortfolio() { refreshPortfolioPrices(); renderPortfolio(); }

function renderPortfolio() {
  const isEmpty = portfolio.length===0;
  document.getElementById('portfolioEmpty').style.display=isEmpty?'block':'none';
  document.getElementById('portfolioTableWrap').style.display=isEmpty?'none':'block';
  document.getElementById('portfolioChartCard').style.display=isEmpty?'none':'block';
  if(isEmpty) { document.getElementById('portfolioMetrics').innerHTML=''; return; }

  document.getElementById('portfolioBody').innerHTML = portfolio.map(p=>{
    const invested=p.shares*p.buyPrice, curVal=p.shares*p.livePrice, pnl=curVal-invested;
    const fees=(invested+curVal)*FEE_ONE_SIDE, netPnl=pnl-fees;
    const ret=invested>0?(pnl/invested*100).toFixed(2):'0';
    const pc=pnl>=0?'var(--green)':'var(--red)';
    const scanRow=scanResults.find(r=>r.symbol===p.symbol||r.symbol.startsWith(p.symbol.split('.')[0]+'.'));
    const sigBadge=scanRow?`<span class="signal-badge badge-${scanRow.signal.toLowerCase()}">${scanRow.signal}</span>`:'—';
    return `<tr>
      <td><strong style="font-family:var(--mono)">${p.symbol.split('.')[0]}</strong></td>
      <td style="color:var(--text2);font-size:11px">${p.name}</td>
      <td style="text-align:right;font-family:var(--mono)">${p.shares}</td>
      <td style="text-align:right;font-family:var(--mono)">${fmt(p.buyPrice)}</td>
      <td style="text-align:right;font-family:var(--mono)">${fmt(p.livePrice)}</td>
      <td style="text-align:right;font-family:var(--mono)">${fmtBig(invested)}</td>
      <td style="text-align:right;font-family:var(--mono)">${fmtBig(curVal)}</td>
      <td style="text-align:right;font-family:var(--mono);color:${pc}">${pnl>=0?'+':''}${fmtBig(pnl)}</td>
      <td style="text-align:right;font-family:var(--mono);color:${pc}">${pnl>=0?'+':''}${ret}%</td>
      <td style="text-align:right">${sigBadge}</td>
      <td style="text-align:right"><button onclick="removePosition('${p.symbol}')" style="font-size:10px;padding:3px 8px;background:var(--red-dim);border:1px solid rgba(240,79,79,0.2);color:var(--red);border-radius:4px;cursor:pointer">Remove</button></td>
    </tr>`;
  }).join('');

  const totalInv=portfolio.reduce((a,p)=>a+p.shares*p.buyPrice,0);
  const totalVal=portfolio.reduce((a,p)=>a+p.shares*p.livePrice,0);
  const pnl=totalVal-totalInv;
  const fees=portfolio.reduce((a,p)=>(a+(p.shares*p.buyPrice+p.shares*p.livePrice)*FEE_ONE_SIDE),0);
  const netPnl=pnl-fees;
  const pct=totalInv>0?(pnl/totalInv*100).toFixed(2):'0';
  document.getElementById('portfolioMetrics').innerHTML=[
    {label:'Portfolio Value',val:`LKR ${totalVal.toFixed(0)}`,sub:`${pnl>=0?'+':''}${pct}% gross`,cls:pnl>=0?'up':'dn'},
    {label:'Total Invested', val:`LKR ${totalInv.toFixed(0)}`,sub:`${portfolio.length} positions`,cls:'neutral'},
    {label:'Net P&L',        val:`${netPnl>=0?'+':''}LKR ${netPnl.toFixed(0)}`,sub:'After est. fees',cls:netPnl>=0?'up':'dn'},
    {label:'Est. Fees',      val:`LKR ${fees.toFixed(0)}`,sub:`${(FEE_ROUND_TRIP*100).toFixed(2)}% round trip`,cls:'neutral'},
  ].map(c=>`<div class="metric-cell"><div class="metric-label">${c.label}</div><div class="metric-value">${c.val}</div><div class="metric-sub ${c.cls}">${c.sub}</div></div>`).join('');

  renderAllocChart();
}

function renderAllocChart() {
  const el = document.getElementById('allocChart');
  if(!el||!portfolio.length) return;
  if(allocChart) allocChart.destroy();
  const colors=['#3ecf72','#4d9cf5','#f5a623','#f04f4f','#a78bfa','#34d399','#fb7185','#60a5fa'];
  allocChart=new Chart(el,{type:'doughnut',data:{labels:portfolio.map(p=>p.symbol.split('.')[0]),datasets:[{data:portfolio.map(p=>p.shares*p.buyPrice),backgroundColor:portfolio.map((_,i)=>colors[i%colors.length]),borderWidth:0,hoverOffset:4}]},options:{responsive:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: LKR ${ctx.parsed.toFixed(0)}`}}},cutout:'68%'}});
  const legend=document.getElementById('allocLegend');
  if(legend) legend.innerHTML=portfolio.map((p,i)=>`<div class="alloc-row"><div class="alloc-swatch" style="background:${colors[i%colors.length]}"></div><span class="alloc-ticker">${p.symbol.split('.')[0]}</span><span class="alloc-lkr">LKR ${(p.shares*p.buyPrice).toFixed(0)}</span></div>`).join('');
}

function exportPortfolioCSV() {
  if(!portfolio.length) return;
  const rows=[['Symbol','Name','Shares','BuyPrice','LivePrice','Invested','Value','GrossPnL','EstFees','NetPnL','Return%']];
  portfolio.forEach(p=>{ const inv=p.shares*p.buyPrice,val=p.shares*p.livePrice,pnl=val-inv,fees=(inv+val)*FEE_ONE_SIDE; rows.push([p.symbol,p.name,p.shares,p.buyPrice,p.livePrice,inv.toFixed(0),val.toFixed(0),pnl.toFixed(0),fees.toFixed(0),(pnl-fees).toFixed(0),(inv>0?(pnl/inv*100).toFixed(2):'0')]); });
  downloadCSV(rows, `cse-portfolio-${new Date().toISOString().slice(0,10)}.csv`);
}

/* ============================================================
   COMBINED P&L REPORT
============================================================ */
function renderPnlTable() {
  const combined = [
    ...autoPortfolio.map(p=>({...p, source:'AUTO'})),
    ...portfolio.map(p=>({...p, source:'MANUAL'})),
  ];

  if(!combined.length) {
    document.getElementById('pnlTableBody').innerHTML='<tr><td colspan="10" class="empty">No positions. Add stocks or use the Auto-Invest Engine.</td></tr>';
    document.getElementById('pnlMetrics').innerHTML='';
    return;
  }

  const totalInv = combined.reduce((a,p)=>a+p.shares*p.buyPrice,0);
  const totalVal = combined.reduce((a,p)=>a+p.shares*p.livePrice,0);
  const gross    = totalVal-totalInv;
  const fees     = combined.reduce((a,p)=>a+(p.shares*p.buyPrice+p.shares*p.livePrice)*FEE_ONE_SIDE,0);
  const net      = gross-fees;
  const pct      = totalInv>0?(gross/totalInv*100).toFixed(2):'0';
  const netPct   = totalInv>0?(net/totalInv*100).toFixed(2):'0';
  const cash     = BUDGET-totalInv; // not used for auto cash, but for reference

  document.getElementById('pnlMetrics').innerHTML=[
    {label:'Combined Value',    val:`LKR ${totalVal.toFixed(0)}`,sub:`${gross>=0?'+':''}${pct}% gross`,cls:gross>=0?'up':'dn'},
    {label:'Total Invested',    val:`LKR ${totalInv.toFixed(0)}`,sub:`${combined.length} positions`,cls:'neutral'},
    {label:'Net P&L (after fees)',val:`${net>=0?'+':''}LKR ${net.toFixed(0)}`,sub:`${netPct>=0?'+':''}${netPct}% net`,cls:net>=0?'up':'dn'},
    {label:'Cash Reserve (ref)',      val:`LKR ${cash.toFixed(0)}`,sub:'Budget minus positions',cls:'neutral'},
  ].map(c=>`<div class="metric-cell"><div class="metric-label">${c.label}</div><div class="metric-value">${c.val}</div><div class="metric-sub ${c.cls}">${c.sub}</div></div>`).join('');

  document.getElementById('pnlTableBody').innerHTML = combined.map(p=>{
    const inv=p.shares*p.buyPrice, val=p.shares*p.livePrice, pnl=val-inv;
    const fees=(inv+val)*FEE_ONE_SIDE, netPnl=pnl-fees;
    const ret=inv>0?(pnl/inv*100).toFixed(2):'0';
    const pc=pnl>=0?'var(--green)':'var(--red)';
    const nc=netPnl>=0?'var(--green)':'var(--red)';
    const scanRow=scanResults.find(r=>r.symbol===p.symbol||r.symbol.startsWith(p.symbol.split('.')[0]+'.'));
    const sigBadge=scanRow?`<span class="signal-badge badge-${scanRow.signal.toLowerCase()}">${scanRow.signal}</span>`:'—';
    const sourceBadge=p.source==='AUTO'?`<span style="font-size:9px;background:var(--green-dim);color:var(--green);border-radius:3px;padding:1px 6px;font-family:var(--mono)">AUTO</span>`:`<span style="font-size:9px;background:var(--surface3);color:var(--text2);border-radius:3px;padding:1px 6px;font-family:var(--mono)">MANUAL</span>`;
    return `<tr>
      <td><strong style="font-family:var(--mono)">${p.symbol.split('.')[0]}</strong><br><span style="color:var(--text2);font-size:10px">${p.name}</span></td>
      <td>${sourceBadge}</td>
      <td style="text-align:right;font-family:var(--mono)">${p.shares}</td>
      <td style="text-align:right;font-family:var(--mono)">${fmt(p.buyPrice)}</td>
      <td style="text-align:right;font-family:var(--mono)">${fmt(p.livePrice)}</td>
      <td style="text-align:right;font-family:var(--mono)">${fmtBig(inv)}</td>
      <td style="text-align:right;font-family:var(--mono)">${fmtBig(val)}</td>
      <td style="text-align:right;font-family:var(--mono);color:${pc}">${pnl>=0?'+':''}${fmtBig(pnl)}</td>
      <td style="text-align:right;font-family:var(--mono);color:${nc}" title="After fees">${netPnl>=0?'+':''}${fmtBig(netPnl)}<br><span style="font-size:10px;opacity:.6">(${netPnl>=0?'+':''}${ret}%)</span></td>
      <td>${sigBadge}</td>
    </tr>`;
  }).join('');
}

/* ============================================================
   MODAL
============================================================ */
let _modalSymbol = null;
function openDetailModal(symbol) {
  _modalSymbol = symbol;
  const r = scanResults.find(x=>x.symbol===symbol) || liveMarket.find(x=>x.symbol===symbol);
  if(!r) return;
  const sclass = r.signal==='BUY'?'badge-buy':r.signal==='SELL'?'badge-sell':'badge-watch';
  document.getElementById('modalTitle').textContent = `${symbol.split('.')[0]} — ${r.name||symbol}`;
  document.getElementById('modalSub').textContent   = `CSE · ${r.signal||'Live price'}`;

  const indBlock = (r.rsi!=null||r.ma20!=null) ? `
    <div class="modal-section-title">Technical Indicators</div>
    ${r.rsi!=null?`<div class="modal-row"><span class="mk">RSI (14)</span><span class="mv ${r.rsi<RSI_OVERSOLD?'up':r.rsi>RSI_OVERBOUGHT?'dn':'neutral'}">${r.rsi} ${r.rsi<RSI_OVERSOLD?'— oversold':r.rsi>RSI_OVERBOUGHT?'— overbought':''}</span></div>`:''}
    ${r.ma20!=null?`<div class="modal-row"><span class="mk">20-day MA</span><span class="mv">LKR ${fmt(r.ma20)} <span class="${r.lastPrice>r.ma20?'up':'dn'}">(${r.lastPrice>r.ma20?'above ▲':'below ▼'})</span></span></div>`:''}
    ${r.ma50!=null?`<div class="modal-row"><span class="mk">50-day MA</span><span class="mv">LKR ${fmt(r.ma50)} <span class="${r.lastPrice>r.ma50?'up':'dn'}">(${r.lastPrice>r.ma50?'above ▲':'below ▼'})</span></span></div>`:''}
    ${r.volRatio!=null?`<div class="modal-row"><span class="mk">Volume vs avg</span><span class="mv ${r.volRatio>=VOL_SPIKE_THRESH?'up':'neutral'}">${r.volRatio.toFixed(2)}× 20-day avg</span></div>`:''}
    ${r.momentum!=null?`<div class="modal-row"><span class="mk">7-day momentum</span><span class="mv ${r.momentum>=0?'up':'dn'}">${r.momentum>=0?'+':''}${r.momentum.toFixed(2)}%</span></div>`:''}
  ` : '';

  const feeBlock = `
    <div class="modal-section-title">Sampath Securities Fees</div>
    <div class="modal-row"><span class="mk">Round-trip fees</span><span class="mv neutral">${(FEE_ROUND_TRIP*100).toFixed(2)}% (LKR ${fmt(r.lastPrice*FEE_ROUND_TRIP)} / share)</span></div>
    <div class="modal-row"><span class="mk">Break-even move needed</span><span class="mv">${(FEE_ROUND_TRIP*100).toFixed(2)}%</span></div>
  `;

  const targetBlock = r.signal==='BUY' ? `
    <div class="modal-section-title">Trade Setup</div>
    <div class="modal-row"><span class="mk">Entry price</span><span class="mv">LKR ${fmt(r.lastPrice)}</span></div>
    <div class="modal-row"><span class="mk">Target (+${(TARGET_PCT*100).toFixed(0)}%)</span><span class="mv up">LKR ${fmt(r.targetPrice)}</span></div>
    <div class="modal-row"><span class="mk">Stop loss (-${(STOPLOSS_PCT*100).toFixed(0)}%)</span><span class="mv dn">LKR ${fmt(r.stopLossPrice)}</span></div>
    <div class="modal-row"><span class="mk">Net profit at target</span><span class="mv ${r.netProfitTarget>0?'up':'dn'}">LKR ${fmt(r.netProfitTarget)} / share after fees</span></div>
  ` : '';

  const inAuto = autoPortfolio.some(p=>p.symbol===symbol);
  document.getElementById('modalAutoBtn').style.display = (r.signal==='BUY'&&!inAuto) ? 'block' : 'none';

  document.getElementById('modalBody').innerHTML=`
    ${r.signal?`<div style="margin-bottom:12px"><span class="signal-badge ${sclass}" style="font-size:13px;padding:5px 14px">${r.signal}</span><span style="margin-left:10px;font-size:12px;color:var(--text2)">${r.reason||''}</span></div>`:''}
    <div class="modal-section-title">Price</div>
    <div class="modal-row"><span class="mk">Last Price</span><span class="mv">LKR ${fmt(r.lastPrice)}</span></div>
    <div class="modal-row"><span class="mk">Change Today</span><span class="mv ${cls(r.changePct)}">${sgn(r.changePct)}${fmt(r.changePct)}%</span></div>
    <div class="modal-row"><span class="mk">Open / High / Low</span><span class="mv">${fmt(r.open)} / ${fmt(r.high)} / ${fmt(r.low)}</span></div>
    <div class="modal-row"><span class="mk">Volume</span><span class="mv">${fmtBig(r.volume)}</span></div>
    ${r.score!=null?`<div class="modal-row"><span class="mk">Signal Score</span><span class="mv">${r.score} / 5</span></div>`:''}
    ${indBlock}${targetBlock}${feeBlock}
  `;
  document.getElementById('stockModal').classList.add('open');
}

function closeModal() { document.getElementById('stockModal').classList.remove('open'); }
document.getElementById('stockModal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeModal(); });
document.getElementById('sellModal').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeSellModal(); });

/* ============================================================
   BUDGET & SETTINGS (with sync for auto cash)
============================================================ */
function updateBudgetBar() {
  const set = (id, val) => { const e = document.getElementById(id); if(e) e.innerHTML = val; };
  set('sbBudgetRef', BUDGET.toLocaleString());
  set('sbAutoCash', `LKR ${fmt(autoCashBalance,0)}`);
  const cashStatus = autoCashBalance >= 1000 ? 'Available for auto trades' : (autoCashBalance < 0 ? '⚠️ Negative cash!' : 'Low cash');
  const cs = document.getElementById('sbCashStatus');
  if(cs) { cs.textContent = cashStatus; cs.style.color = autoCashBalance < 0 ? 'var(--red)' : 'var(--text2)'; }
  const allPos = [...autoPortfolio, ...portfolio];
  const totalInv = allPos.reduce((a,p)=>a+p.shares*p.buyPrice,0);
  const totalVal = allPos.reduce((a,p)=>a+p.shares*p.livePrice,0);
  const pnl = totalVal - totalInv;
  const ret = document.getElementById('sbReturn');
  if(ret) {
    if(allPos.length) {
      const pct = totalInv>0?(pnl/totalInv*100).toFixed(2):'0';
      ret.textContent = `${pnl>=0?'+':''}${pct}% unrealised`;
      ret.className = `bs ${pnl>=0?'up':'dn'}`;
    } else {
      ret.textContent = 'Ready to invest';
      ret.className = 'bs';
    }
  }
}

function updateBudget() {
  const v = parseInt(document.getElementById('budgetInput').value);
  if(v>=100) { BUDGET=v; document.getElementById('settingBudget').value=v; document.getElementById('budgetInput').value=''; updateBudgetBar(); if(scanResults.length) rerenderScanResults(); }
}

function syncAutoCashToBudget() {
  if(confirm(`Set auto cash to current budget reference (${BUDGET.toLocaleString()} LKR)? This will replace your current auto cash balance (${fmt(autoCashBalance,0)} LKR).`)) {
    autoCashBalance = BUDGET;
    saveAutoPortfolio();
    updateBudgetBar();
    renderAutoPortfolio();
    showToast(`Auto cash synced to LKR ${fmt(autoCashBalance,0)}`, 'info');
  }
}

function applySettings() {
  const v = parseInt(document.getElementById('settingBudget').value);
  if(v>=100) { BUDGET=v; updateBudgetBar(); if(scanResults.length) rerenderScanResults(); }
}

function toggleSetting(btn) { btn.classList.toggle('on'); rerenderScanResults(); }

function setRefreshInterval(secs) {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    loaded = {};
    loadSummary().then(() => {
      if(autoEngineRunning && scanResults.length) runAutoInvestCycle();
    });
  }, secs * 1000);
}

/* ============================================================
   NAVIGATION
============================================================ */
function showPage(name, el) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  if(el) el.classList.add('active');
  currentPage=name;
  if(name==='movers')        loadMovers();
  if(name==='announcements') loadAnnouncements();
  if(name==='portfolio')     { refreshPortfolioPrices(); renderPortfolio(); }
  if(name==='pnl')           { refreshPortfolioPrices(); refreshAutoPortfolioPrices(); renderPnlTable(); }
  if(name==='auto')          { refreshAutoPortfolioPrices(); renderAutoPortfolio(); }
  if(name==='log')           renderTradeLog();
}

function refreshCurrent() {
  const btn=document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  loaded = {};
  if(currentPage==='summary')            loadSummary();
  else if(currentPage==='movers')        loadMovers();
  else if(currentPage==='announcements') loadAnnouncements();
  else if(currentPage==='scan')          runScan();
  else if(currentPage==='portfolio')     { refreshPortfolioPrices(); renderPortfolio(); }
  else if(currentPage==='auto')          { refreshAutoPortfolioPrices(); renderAutoPortfolio(); }
  else if(currentPage==='pnl')           { loadSummary(); }
  setTimeout(()=>btn.classList.remove('spinning'), 800);
}

function downloadCSV(rows, filename) {
  const csv = rows.map(r=>r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download = filename;
  a.click();
}

/* ============================================================
   INIT
============================================================ */
function init() {
  loadPortfolioFromStorage();
  loadAutoPortfolio();   // also loads autoCashBalance
  loadTradeLog();
  setupAutocomplete();
  buildTape(null);
  loadSummary();
  setRefreshInterval(60);
  updateBudgetBar();
  updateMarketStatusUI();
  document.getElementById('sbAutoCount').textContent = autoPortfolio.length;
  if(autoPortfolio.length) renderAutoPortfolio();
}
init();
