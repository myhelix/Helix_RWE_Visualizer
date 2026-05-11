/* ============================================================
   VUS Evidence Visualizer — Application Logic
   ============================================================ */

// ---- Evidence colors & thresholds ----
const COLORS = {
  BVS:     '#3c486c',
  BS:      '#5d6a8a',
  BM:      '#7e8ca8',
  BP:      '#9faec6',
  neutral: '#e0e0e0',
  PP:      '#f5bfcd',
  PM:      '#efa1b5',
  PS:      '#e9839d',
  PVS:     '#e36585',
};

const CATEGORIES = ['BVS','BS','BM','BP','neutral','PP','PM','PS','PVS'];

// LR thresholds (upper bound for benign, lower for pathogenic)
function lrToCategory(lr) {
  if (lr <= 0 || isNaN(lr)) return 'neutral';
  if (lr <= 0.0029) return 'BVS';
  if (lr <= 0.053)  return 'BS';
  if (lr <= 0.23)   return 'BM';
  if (lr <= 0.48)   return 'BP';
  if (lr < 2.08)    return 'neutral';
  if (lr < 4.33)    return 'PP';
  if (lr < 18.7)    return 'PM';
  if (lr < 350)     return 'PS';
  return 'PVS';
}

// ---- Config (set per-page before this script loads) ----
// Public page:   window.APP_CONFIG = { showFullData: false }  (default)
// Internal page: window.APP_CONFIG = { showFullData: true }
const SHOW_FULL = !!(window.APP_CONFIG && window.APP_CONFIG.showFullData);

// ---- State ----
let geneParams  = {};     // from gene_params.json
let geneCache   = {};     // gene -> array of variant records
let selectedGene = null;
const loadingGenes = new Set();  // genes currently being fetched
const activeFilters = new Set(); // active category filters (empty = show all)
let debounceTimer = null;

// ---- DOM refs ----
const geneSelect    = document.getElementById('gene-select');
const variantSearch = document.getElementById('variant-search');
const searchResults = document.getElementById('search-results');
const variantSection = document.getElementById('variant-section');
const quantNotice   = document.getElementById('quant-notice');
const plotContainer = document.getElementById('plot-container');

// ---- Bootstrap ----
async function init() {
  // Warn if opened as file:// instead of via the server
  if (window.location.protocol === 'file:') {
    const warn = document.createElement('div');
    warn.style.cssText = 'background:#c00;color:#fff;padding:16px 24px;font-weight:bold;font-size:1rem;text-align:center';
    warn.innerHTML = 'Page opened as a local file — data cannot load. '
      + 'Open the page via the hosted URL instead.';
    document.body.insertBefore(warn, document.body.firstChild);
    return;
  }

  // Load gene params
  let resp;
  try {
    resp = await fetch('gene_params.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch (e) {
    document.querySelector('main').innerHTML =
      `<div style="padding:32px;color:#c00;font-size:1rem">
        <b>Failed to load site data.</b><br>
        <a href="javascript:location.reload()">Reload the page</a> to try again.
      </div>`;
    return;
  }
  geneParams = await resp.json();

  // Populate gene dropdown
  const genes = Object.keys(geneParams).sort();
  genes.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g + (geneParams[g] ? ` — ${geneParams[g].phenotype}` : '');
    geneSelect.appendChild(opt);
  });

  geneSelect.addEventListener('change', onGeneChange);
  variantSearch.addEventListener('input', onVariantInput);
  variantSearch.addEventListener('focus', onVariantInput);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-section')) hideResults();
  });

  // Category filter buttons
  const filterRow = document.createElement('div');
  filterRow.className = 'filter-row';
  const filterLabel = document.createElement('span');
  filterLabel.className = 'filter-label';
  filterLabel.textContent = 'Filter:';
  filterRow.appendChild(filterLabel);

  const catDescriptions = {
    BVS: 'Very Strong Benign', BS: 'Strong Benign', BM: 'Moderate Benign', BP: 'Supporting Benign',
    neutral: 'Neutral', PP: 'Supporting Pathogenic', PM: 'Moderate Pathogenic',
    PS: 'Strong Pathogenic', PVS: 'Very Strong Pathogenic',
  };
  CATEGORIES.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.dataset.cat = cat;
    btn.textContent = cat === 'neutral' ? 'N' : cat;
    btn.title = catDescriptions[cat];
    btn.style.setProperty('--btn-color', COLORS[cat]);
    btn.addEventListener('click', () => {
      if (activeFilters.has(cat)) {
        activeFilters.delete(cat);
        btn.classList.remove('active');
      } else {
        activeFilters.add(cat);
        btn.classList.add('active');
      }
      const gene = selectedGene;
      if (gene && geneCache[gene]) {
        const q = variantSearch.value.trim().toLowerCase();
        if (q || activeFilters.size > 0) renderResults(gene, q);
        else hideResults();
      }
    });
    filterRow.appendChild(btn);
  });
  document.querySelector('.search-section').appendChild(filterRow);
}

// ---- Gene selection ----
async function onGeneChange() {
  const gene = geneSelect.value;
  selectedGene = gene || null;
  variantSearch.value = '';
  hideResults();
  variantSection.classList.add('hidden');

  if (!gene) return;

  if (!geneCache[gene]) {
    await loadGeneData(gene);
  }
}

async function loadGeneData(gene) {
  if (geneCache[gene] || loadingGenes.has(gene)) return;
  loadingGenes.add(gene);

  // Show a loading indicator in the search results
  searchResults.innerHTML = `<div class="loading-msg">Loading ${gene} variants…</div>`;
  searchResults.classList.remove('hidden');

  try {
    const resp = await fetch(`data/genes/${gene}.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    geneCache[gene] = await resp.json();
  } catch (e) {
    searchResults.innerHTML = `<div class="loading-msg" style="color:#c00">
      Failed to load ${gene} data: ${e.message}<br>
      <a href="#" onclick="location.reload();return false;" style="color:#3c486c">Reload page</a>
    </div>`;
    loadingGenes.delete(gene);
    return;
  }

  loadingGenes.delete(gene);
  if (selectedGene !== gene) return;
  const q = variantSearch.value.trim();
  if (q || activeFilters.size > 0) {
    renderResults(gene, q);
  } else {
    showResultsMsg(`${geneCache[gene].length.toLocaleString()} variants loaded — type to search.`);
  }
}

// ---- Variant search ----
function onVariantInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const gene = selectedGene;
    const query = variantSearch.value.trim().toLowerCase();

    if (!gene) {
      showResultsMsg('Select a gene first.');
      return;
    }
    if (!geneCache[gene]) {
      loadGeneData(gene).then(() => {
        if (query) renderResults(gene, query);
        else hideResults();
      });
      return;
    }
    if (!query && activeFilters.size === 0) { hideResults(); return; }
    renderResults(gene, query);
  }, 120);
}

function renderResults(gene, query) {
  const records = geneCache[gene];
  if (!records) return;

  const terms = query.split(/\s+/);

  const matches = records.filter(r => {
    const haystack = [r.v, r.p, r.c, gene].join(' ').toLowerCase();
    if (!terms.every(t => haystack.includes(t))) return false;
    if (activeFilters.size > 0 && !activeFilters.has(r.rwe || 'neutral')) return false;
    return true;
  });

  if (matches.length === 0) {
    const filterDesc = activeFilters.size > 0 ? `[${[...activeFilters].join(', ')}]` : '';
    const queryDesc  = query ? `"${query}"` : '';
    const desc = [queryDesc, filterDesc].filter(Boolean).join(' ');
    showResultsMsg(`No variants found${desc ? ` matching ${desc}` : ''}.`);
    return;
  }

  const MAX = 50;
  const shown = matches.slice(0, MAX);
  const frag = document.createDocumentFragment();

  shown.forEach(r => {
    const div = document.createElement('div');
    div.className = 'result-item';

    const rweLabel = r.rwe || '—';
    const badgeClass = `badge-${rweLabel}`;

    div.innerHTML = `
      <span class="result-gene">${gene}</span>
      <span class="result-hgvsp">${r.p || r.v}</span>
      <span class="result-hgvsc">${r.c || ''}</span>
      <span class="result-badge ${badgeClass}">${rweLabel}</span>
    `;
    div.addEventListener('click', () => selectVariant(gene, r));
    frag.appendChild(div);
  });

  if (matches.length > MAX) {
    const more = document.createElement('div');
    more.className = 'result-more';
    more.textContent = `Showing ${MAX} of ${matches.length} matches. Refine your search.`;
    frag.appendChild(more);
  }

  searchResults.innerHTML = '';
  searchResults.appendChild(frag);
  searchResults.classList.remove('hidden');
}

function showResultsMsg(msg) {
  searchResults.innerHTML = `<div class="result-more">${msg}</div>`;
  searchResults.classList.remove('hidden');
}
function hideResults() {
  searchResults.classList.add('hidden');
}

// ---- Variant selection ----
function selectVariant(gene, record) {
  hideResults();
  variantSearch.value = record.p || record.v;

  // Update info card
  document.getElementById('disp-gene').textContent = gene;
  document.getElementById('disp-hgvsp').textContent = record.p || '';
  document.getElementById('disp-hgvsc').textContent = record.c || '';
  document.getElementById('disp-genomic').textContent = record.v || '';
  document.getElementById('disp-consequence').textContent = record.csq || '';
  const txEl = document.getElementById('disp-transcript');
  if (txEl) txEl.textContent = (geneParams[gene] && geneParams[gene].transcript) ? geneParams[gene].transcript : '';

  const rweEl = document.getElementById('disp-rwe');
  rweEl.textContent = record.rwe || '—';
  rweEl.className = `class-badge badge-${record.rwe || 'neutral'}`;

  // Full-data fields (internal version only)
  const fullDataEls = document.querySelectorAll('.full-data-only');
  fullDataEls.forEach(el => el.style.display = SHOW_FULL ? '' : 'none');

  if (SHOW_FULL) {
    const ncEl = document.getElementById('disp-nc');
    if (ncEl) {
      ncEl.textContent = record.nc || '—';
      ncEl.className = `class-badge badge-${record.nc || 'neutral'}`;
    }
    const cvEl = document.getElementById('disp-cv');
    if (cvEl) cvEl.textContent = record.cv || '—';
    const apEl = document.getElementById('disp-ap');
    if (apEl) apEl.textContent = record.ap != null ? record.ap : '—';
  }

  const lrFmt = record.lr == null ? '—'
    : record.lr === 0 ? '0'
    : record.lr < 0.001 ? record.lr.toExponential(2)
    : record.lr > 1e6 ? record.lr.toExponential(2)
    : record.lr.toPrecision(4);
  document.getElementById('disp-lr').textContent = lrFmt;

  variantSection.classList.remove('hidden');

  const params = geneParams[gene];
  quantNotice.classList.add('hidden');
  plotContainer.innerHTML = '';
  if (params) {
    setTimeout(() => renderPlot(gene, record, params), 50);
  }
}

// ---- Plot rendering ----
function isPlotlyAvailable() {
  return typeof Plotly !== 'undefined' && typeof Plotly.newPlot === 'function';
}

function normalPDF(x, mu, sigma) {
  return (1.0 / (sigma * Math.sqrt(2 * Math.PI))) *
         Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
}

function renderPlot(gene, record, params) {
  if (!isPlotlyAvailable()) {
    plotContainer.innerHTML = '<div style="padding:24px;color:#c00;font-weight:bold">Plotly.js failed to load. Reload the page.</div>';
    return;
  }

  const isQuantitative = params.type === 'quantitative';
  const pathOR    = params.pathOR;
  const phenotype = params.phenotype;
  const { or: orVal, lci, uci, lr, rwe, lim } = record;

  // Guard: no statistical data at all
  const hasPoint = isQuantitative ? (orVal != null && orVal > -9) : (orVal != null && orVal > 0);
  const hasAnyData = hasPoint || lci != null || uci != null || lr != null;
  if (!hasAnyData) {
    plotContainer.innerHTML = `<div style="padding:48px;text-align:center;color:var(--color-text-muted);font-size:0.95rem">
      No statistical data available for this variant.
    </div>`;
    document.getElementById('downgrade-note').classList.add('hidden');
    return;
  }

  try {

  const isDowngraded = (lim === 'sample_size') && !!rwe;

  // SE on the appropriate scale
  let se;
  if (isQuantitative) {
    se = (lci != null && uci != null && uci > lci) ? (uci - lci) / (2 * 1.96) : 0.25;
  } else {
    se = (lci != null && uci != null && lci > 0 && uci > 0 && uci > lci)
      ? (Math.log(uci) - Math.log(lci)) / (2 * 1.96) : 0.5;
  }

  // Proxy position for privacy-masked point estimates
  let orProxy;
  if (isQuantitative) {
    orProxy = hasPoint ? orVal : (lci != null && uci != null ? (lci + uci) / 2 : null);
  } else {
    orProxy = hasPoint ? orVal
      : (lci != null && lci > 0 && uci != null && uci > 0)
        ? Math.exp((Math.log(lci) + Math.log(uci)) / 2) : null;
  }

  // X-axis range
  const N = 500;
  let xRange, axisXMin, axisXMax;

  if (isQuantitative) {
    const lrBound  = (k) => Math.log(k) * se ** 2 / pathOR + pathOR / 2;
    const x_bvs    = lrBound(0.0029), x_pvs = lrBound(350);
    const leftPad  = x_bvs - (lrBound(0.053) - x_bvs);
    const rightPad = x_pvs + (x_pvs - lrBound(18.7));
    const pts = [orProxy, lci, uci].filter(v => v != null);
    axisXMin = Math.min(leftPad, ...pts, -se);
    axisXMax = Math.max(rightPad, ...pts, pathOR + se);
    xRange = Array.from({length: N}, (_, i) => axisXMin + (axisXMax - axisXMin) * i / (N - 1));
  } else {
    const logPathOR    = Math.log(pathOR);
    const lrBoundLogOR = (k) => Math.log(k) * se ** 2 / logPathOR + logPathOR / 2;
    const logOR_bvs    = lrBoundLogOR(0.0029);
    const logOR_pvs    = lrBoundLogOR(350);
    const leftPad      = logOR_bvs - (lrBoundLogOR(0.053) - logOR_bvs);
    const rightPad     = logOR_pvs + (logOR_pvs - lrBoundLogOR(18.7));
    const logPts = [orProxy, lci, uci].filter(v => v != null && v > 0).map(Math.log);
    const logMin = Math.min(leftPad, ...logPts, -se);
    const logMax = Math.max(rightPad, ...logPts, logPathOR + se);
    const logArray = Array.from({length: N}, (_, i) => logMin + (logMax - logMin) * i / (N - 1));
    xRange   = logArray.map(x => Math.exp(x));
    axisXMin = logMin;
    axisXMax = logMax;
  }

  // Distributions (y values at each x)
  let distBenign, distPath;
  if (isQuantitative) {
    distBenign = xRange.map(x => normalPDF(x, 0, se));
    distPath   = xRange.map(x => normalPDF(x, pathOR, se));
  } else {
    distBenign = xRange.map(x => normalPDF(Math.log(x), 0, se));
    distPath   = xRange.map(x => normalPDF(Math.log(x), Math.log(pathOR), se));
  }
  const lrCurve = distPath.map((p, i) => Math.max(1e-6, Math.min(1e8, p / distBenign[i])));
  const yMax = Math.max(...distBenign, ...distPath) * 1.15;

  // Color strip
  const stripSegments = buildColorSegments(xRange, lrCurve);

  // ---- Traces ----
  const traces = [];
  const benignLegend = isQuantitative ? 'Benign (Exp. Effect=0)' : 'Benign (Exp. OR=1)';
  const pathLegend   = isQuantitative
    ? `Pathogenic (Exp. Effect=${fmtNum(pathOR)})` : `Pathogenic (Exp. OR=${fmtNum(pathOR)})`;

  traces.push({ x: xRange, y: distBenign, fill: 'tozeroy', fillcolor: 'rgba(126,140,168,0.25)',
    line: { color: 'rgba(93,106,138,0)', width: 0 }, mode: 'lines', xaxis: 'x', yaxis: 'y',
    showlegend: false, hoverinfo: 'skip', name: 'Benign fill' });
  traces.push({ x: xRange, y: distPath, fill: 'tozeroy', fillcolor: 'rgba(233,131,157,0.25)',
    line: { color: 'rgba(233,131,157,0)', width: 0 }, mode: 'lines', xaxis: 'x', yaxis: 'y',
    showlegend: false, hoverinfo: 'skip', name: 'Path fill' });
  traces.push({ x: xRange, y: distBenign, mode: 'lines', line: { color: COLORS.BS, width: 2.5 },
    xaxis: 'x', yaxis: 'y', showlegend: true, hoverinfo: 'skip', name: benignLegend });
  traces.push({ x: xRange, y: distPath, mode: 'lines', line: { color: COLORS.PS, width: 2.5 },
    xaxis: 'x', yaxis: 'y', showlegend: true, hoverinfo: 'skip', name: pathLegend });

  stripSegments.forEach(seg => {
    traces.push({ x: [seg.x0, seg.x0, seg.x1, seg.x1, seg.x0], y: [0, 1, 1, 0, 0],
      fill: 'toself', fillcolor: seg.color, mode: 'lines', line: { width: 0, color: seg.color },
      xaxis: 'x2', yaxis: 'y2', showlegend: false, hoverinfo: 'text', text: seg.cat, name: seg.cat });
  });

  if (orProxy != null) {
    const ptLabel = hasPoint
      ? (isQuantitative ? `Observed Effect = ${fmtNum(orProxy)}` : `Observed OR = ${fmtNum(orProxy)}`)
      : `CI midpoint = ${fmtNum(orProxy)} (point est. masked)`;

    if (isDowngraded) {
      traces.push({ x: [orProxy], y: [0.5], mode: 'markers',
        marker: { color: '#aaaaaa', size: 12, symbol: 'circle', line: { color: '#555', width: 1.5 } },
        xaxis: 'x2', yaxis: 'y2', showlegend: false,
        hovertemplate: `${ptLabel}<br>Raw LR category (downgraded)<extra></extra>`, name: 'Raw position' });
      const downgradedX = findCategoryCenter(rwe, xRange, lrCurve, pathOR, se, isQuantitative);
      if (downgradedX != null) {
        traces.push({ x: [downgradedX], y: [0.5], mode: 'markers',
          marker: { color: '#111111', size: 12, symbol: 'circle', line: { color: '#111', width: 1.5 } },
          xaxis: 'x2', yaxis: 'y2', showlegend: false,
          hovertemplate: `Assigned: ${rwe} (downgraded due to small sample)<extra></extra>`, name: 'Assigned category' });
      }
    } else {
      traces.push({ x: [orProxy], y: [0.5], mode: 'markers',
        marker: { color: '#111111', size: 12, symbol: 'circle', line: { color: '#111', width: 1.5 } },
        xaxis: 'x2', yaxis: 'y2', showlegend: false,
        hovertemplate: `${ptLabel}<br>LR = ${lr != null ? fmtNum(lr) : '—'}<extra></extra>`, name: 'Observed' });
    }
  }

  if (orProxy != null) {
    traces.push({ x: [null], y: [null], mode: 'lines', line: { color: '#000', width: 2.5 },
      name: 'Observed Variant (±95% CI)', showlegend: true, xaxis: 'x', yaxis: 'y' });
  }

  // ---- Shapes ----
  const shapes = [];
  const benignX = isQuantitative ? 0 : 1;

  shapes.push({ type: 'line', xref: 'x', yref: 'y', x0: benignX, x1: benignX, y0: 0, y1: yMax * 0.95,
    line: { color: COLORS.BS, dash: 'dash', width: 1.5 } });
  shapes.push({ type: 'line', xref: 'x', yref: 'y', x0: pathOR, x1: pathOR, y0: 0, y1: yMax * 0.95,
    line: { color: 'rgba(233,131,157,0.55)', dash: 'dash', width: 1.5 } });

  const ciValid = lci != null && uci != null && (isQuantitative ? uci > lci : lci > 0 && uci > 0);
  if (ciValid) {
    shapes.push({ type: 'rect', xref: 'x', yref: 'y', x0: lci, x1: uci, y0: 0, y1: yMax,
      fillcolor: 'rgba(120,120,120,0.15)', line: { width: 0 } });
  }
  if (orProxy != null) {
    shapes.push({ type: 'line', xref: 'x', yref: 'y', x0: orProxy, x1: orProxy, y0: 0, y1: yMax,
      line: { color: '#000', width: 2.5 } });
  }

  // ---- Annotations ----
  const annotations = [];
  const rweLabel    = rwe || '—';
  const resultCat   = rwe || 'neutral';
  const resultColor = COLORS[resultCat] || COLORS.neutral;
  const textColor   = ['BP','neutral','PP','PM'].includes(resultCat) ? '#333' : '#fff';
  const fadedColor  = textColor === '#fff' ? 'rgba(255,255,255,0.45)' : 'rgba(51,51,51,0.4)';

  let annotText = null;
  if (lr != null) {
    if (isDowngraded && rwe) {
      // Unicode combining strikethrough (U+0336) for Plotly-safe rendering
      const rawCat = lrToCategory(lr);
      const struck = rawCat.split('').map(c => c + '\u0336').join('');
      const lrFmt = lr < 0.001 ? lr.toExponential(2) : lr > 1e6 ? lr.toExponential(2) : lr.toPrecision(3);
      annotText = `<b>LR = ${lrFmt}  <span style="color:${fadedColor}">${struck}</span> → ${rweLabel}</b>`;
    } else {
      const lrFmt = lr < 0.001 ? lr.toExponential(2) : lr > 1e6 ? lr.toExponential(2) : lr.toPrecision(3);
      annotText = `<b>LR = ${lrFmt} → ${rweLabel}</b>`;
    }
  }
  if (annotText) {
    annotations.push({ xref: 'paper', yref: 'paper', x: 0.98, y: 0.97, text: annotText,
      showarrow: false, font: { size: 13, color: textColor }, bgcolor: resultColor,
      bordercolor: '#aaa', borderwidth: 1, borderpad: 6, xanchor: 'right', yanchor: 'top' });
  }

  // ---- Layout ----
  let xTickVals, xTickText;
  if (!isQuantitative) {
    const xTickCandidates = [0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 50, 75, 100, 200, 500, 1000, 2000, 5000];
    const inRange = xTickCandidates.filter(v => Math.log(v) >= axisXMin && Math.log(v) <= axisXMax);
    const tickShow = [];
    const minLogGap = inRange.length > 5 ? (Math.log(inRange[inRange.length-1]) - Math.log(inRange[0])) / 4.5 : 0;
    let lastLogTick = -Infinity;
    for (const v of inRange) {
      if (Math.log(v) - lastLogTick >= minLogGap) { tickShow.push(v); lastLogTick = Math.log(v); }
    }
    xTickVals = tickShow;
    xTickText = tickShow.map(String);
  }

  const xAxisTitle = isQuantitative ? 'Effect Size (SD)' : 'Odds Ratio';
  const xAxisCfg = isQuantitative
    ? { type: '-', range: [axisXMin, axisXMax], showgrid: true, gridcolor: '#eee',
        title: { text: xAxisTitle, font: { size: 13, color: '#333' }, standoff: 8 },
        zeroline: true, zerolinecolor: '#ccc', zerolinewidth: 1, domain: [0, 1], anchor: 'y' }
    : { type: 'log', range: [axisXMin / Math.LN10, axisXMax / Math.LN10],
        tickvals: xTickVals, ticktext: xTickText, showgrid: true, gridcolor: '#eee',
        title: { text: xAxisTitle, font: { size: 13, color: '#333' }, standoff: 8 },
        zeroline: false, domain: [0, 1], anchor: 'y' };

  const xAxis2Cfg = isQuantitative
    ? { type: '-', range: [axisXMin, axisXMax], showticklabels: false,
        showgrid: false, zeroline: false, domain: [0, 1], anchor: 'y2' }
    : { type: 'log', range: [axisXMin / Math.LN10, axisXMax / Math.LN10],
        tickvals: xTickVals, ticktext: xTickText, showticklabels: false,
        showgrid: false, zeroline: false, domain: [0, 1], anchor: 'y2' };

  const titleText = `Likelihood Ratio Framework — <b>${gene}</b> (${phenotype}${isQuantitative ? ', Effect Size' : ''})`;
  const layout = {
    height: 550,
    width: Math.max(plotContainer.getBoundingClientRect().width || 0, plotContainer.offsetWidth || 0, 900),
    margin: { t: 48, r: 40, b: 20, l: 60 },
    plot_bgcolor: '#fff',
    paper_bgcolor: '#fff',
    font: { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', size: 12 },
    xaxis:  xAxisCfg,
    yaxis:  { range: [0, yMax], title: { text: 'Probability Density', font: { size: 13, color: '#333' }, standoff: 6 },
              showgrid: true, gridcolor: '#eee', domain: [0.36, 1.0], anchor: 'x' },
    xaxis2: xAxis2Cfg,
    yaxis2: { range: [0, 1], domain: [0.06, 0.24], showticklabels: false,
              showgrid: false, zeroline: false, anchor: 'x2' },
    title:  { text: titleText, font: { size: 15, color: '#1a1d2e' }, x: 0.04, xanchor: 'left' },
    shapes,
    annotations,
    showlegend: true,
    legend: { x: 0.02, y: 0.97, xanchor: 'left', yanchor: 'top',
              bgcolor: 'rgba(255,255,255,0.85)', bordercolor: '#ddd', borderwidth: 1, font: { size: 11 } },
  };

  // Downgrade note
  const dnNote = document.getElementById('downgrade-note');
  if (isDowngraded) {
    dnNote.textContent =
      `Note: This variant's LR was downgraded from its raw score due to a small sample size. ` +
      `The gray dot shows where the observed LR falls on the evidence scale; ` +
      `the black dot shows the assigned (downgraded) category.`;
    dnNote.classList.remove('hidden');
  } else {
    dnNote.classList.add('hidden');
  }

  plotContainer.innerHTML = '';
  Plotly.newPlot(plotContainer, traces, layout, {
    staticPlot: true,
  }).then(() => buildLegend())
    .catch(err => {
      plotContainer.innerHTML = `<div style="padding:24px;color:#c00;font-family:monospace">Plotly error: ${err.message}</div>`;
    });

  } catch(err) {
    plotContainer.innerHTML = `<div style="padding:24px;color:#c00;font-family:monospace;font-size:13px">
      <b>Render error:</b> ${err.message}<br>
      <pre style="margin-top:8px;white-space:pre-wrap">${err.stack}</pre>
    </div>`;
  }
}

// ---- Color strip helper ----
function buildColorSegments(orRange, lrValues) {
  const segs = [];
  let curCat = null, curColor = null, x0 = orRange[0];

  for (let i = 0; i < orRange.length; i++) {
    const cat = lrToCategory(lrValues[i]);
    if (cat !== curCat) {
      if (curCat !== null) {
        segs.push({ cat: curCat, color: COLORS[curCat], x0, x1: orRange[i] });
      }
      curCat = cat;
      curColor = COLORS[cat];
      x0 = orRange[i];
    }
  }
  if (curCat) segs.push({ cat: curCat, color: curColor, x0, x1: orRange[orRange.length - 1] });
  return segs;
}

// ---- Find center x position for a category on this variant's LR curve ----
function findCategoryCenter(catName, xRange, lrValues, pathOR, se, isQuantitative) {
  const catXs = xRange.filter((_, i) => lrToCategory(lrValues[i]) === catName);
  if (catXs.length === 0) {
    // Category not in current range; compute analytically from LR midpoint
    const bounds = getCategoryLRBounds(catName);
    const lrMid = Math.sqrt(bounds.lo * (bounds.hi === Infinity ? bounds.lo * 350 : bounds.hi));
    if (lrMid <= 0) return null;
    if (isQuantitative) {
      return Math.log(lrMid) * se ** 2 / pathOR + pathOR / 2;
    }
    const logPathOR = Math.log(pathOR);
    return Math.exp(logPathOR / 2 + Math.log(lrMid) * se ** 2 / logPathOR);
  }
  if (isQuantitative) {
    return catXs.reduce((s, v) => s + v, 0) / catXs.length;
  }
  const sumLog = catXs.reduce((s, v) => s + Math.log(v), 0);
  return Math.exp(sumLog / catXs.length);
}

function getCategoryLRBounds(cat) {
  const map = {
    BVS:     { lo: 0,      hi: 0.0029 },
    BS:      { lo: 0.0029, hi: 0.053  },
    BM:      { lo: 0.053,  hi: 0.23   },
    BP:      { lo: 0.23,   hi: 0.48   },
    neutral: { lo: 0.48,   hi: 2.08   },
    PP:      { lo: 2.08,   hi: 4.33   },
    PM:      { lo: 4.33,   hi: 18.7   },
    PS:      { lo: 18.7,   hi: 350    },
    PVS:     { lo: 350,    hi: Infinity },
  };
  return map[cat] || { lo: 0.48, hi: 2.08 };
}

// ---- Evidence legend (below plot) ----
function buildLegend() {
  // Remove existing legend if any
  const old = document.getElementById('evidence-legend');
  if (old) old.remove();

  const wrapper = document.createElement('div');
  wrapper.id = 'evidence-legend';
  wrapper.className = 'evidence-legend';
  wrapper.innerHTML = `<h4>Evidence Strength</h4>`;

  const items = document.createElement('div');
  items.className = 'legend-items';

  const labelMap = {
    BVS:     'BVS',
    BS:      'BS',
    BM:      'BM',
    BP:      'BP',
    neutral: 'Neutral',
    PP:      'PP',
    PM:      'PM',
    PS:      'PS',
    PVS:     'PVS',
  };
  const descMap = {
    BVS:     'Very Strong Benign',
    BS:      'Strong Benign',
    BM:      'Moderate Benign',
    BP:      'Supporting Benign',
    neutral: 'Neutral / Uncertain',
    PP:      'Supporting Pathogenic',
    PM:      'Moderate Pathogenic',
    PS:      'Strong Pathogenic',
    PVS:     'Very Strong Pathogenic',
  };

  CATEGORIES.forEach((cat, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'legend-sep';
      sep.textContent = '›';
      items.appendChild(sep);
    }
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.title = descMap[cat];
    item.innerHTML = `
      <div class="legend-swatch" style="background:${COLORS[cat]}"></div>
      <span>${labelMap[cat]}</span>
    `;
    items.appendChild(item);
  });

  wrapper.appendChild(items);
  plotContainer.appendChild(wrapper);
}

function fmtNum(n) {
  if (n == null) return '—';
  if (Math.abs(n) >= 1000) return n.toExponential(2);
  if (Math.abs(n) >= 10)   return n.toFixed(1);
  if (Math.abs(n) >= 1)    return n.toFixed(2);
  if (Math.abs(n) >= 0.01) return n.toFixed(3);
  return n.toExponential(2);
}

// ---- Start ----
init();
