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

// Buckets a raw ACMG points value onto the same BVS..PVS scale as
// lrToCategory, using the standard points anchors (PP=1, PM=2, PS=4,
// PVS=8 and mirrored on the benign side) as lower bounds -- so a badge
// color is available for any point total, not just the exact anchors.
function pointsToCategory(pts) {
  if (pts == null || isNaN(pts)) return 'neutral';
  if (pts >= 8) return 'PVS';
  if (pts >= 4) return 'PS';
  if (pts >= 2) return 'PM';
  if (pts >= 1) return 'PP';
  if (pts <= -8) return 'BVS';
  if (pts <= -4) return 'BS';
  if (pts <= -2) return 'BM';
  if (pts <= -1) return 'BP';
  return 'neutral';
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
    const ecEl = document.getElementById('disp-ec');
    if (ecEl) {
      ecEl.textContent = record.ec || '—';
      ecEl.className = `class-badge badge-${record.ec || 'neutral'}`;
    }
    const ncEl = document.getElementById('disp-nc');
    if (ncEl) {
      ncEl.textContent = record.nc || '—';
      ncEl.className = `class-badge badge-${record.nc || 'neutral'}`;
    }
    const cvEl = document.getElementById('disp-cv');
    if (cvEl) {
      cvEl.textContent = record.cv || '—';
      cvEl.className = `class-badge badge-${(record.cv || 'neutral').replace(/\s+/g, '')}`;
    }
    const apEl = document.getElementById('disp-ap');
    if (apEl) {
      apEl.textContent = record.ap != null ? record.ap : '—';
      apEl.className = `class-badge badge-${pointsToCategory(record.ap)}`;
    }
  }

  const lrFmt = record.lr == null ? '—'
    : record.lr === 0 ? '0'
    : record.lr < 0.001 ? record.lr.toExponential(2)
    : record.lr > 1e6 ? record.lr.toExponential(2)
    : record.lr.toPrecision(4);
  const lrEl = document.getElementById('disp-lr');
  lrEl.textContent = lrFmt;
  lrEl.className = `class-badge badge-${lrToCategory(record.lr)}`;

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
  const pathOR     = params.pathOR;
  const pathORLci  = params.pathOR_lci; // v3: uncertainty in the expected-pathogenic anchor itself
  const pathORUci  = params.pathOR_uci;
  const phenotype = params.phenotype;
  const { or: orVal, lci, uci, lr, rwe, lrl, lru, ta } = record;

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

  const isDowngraded = !!ta && !!rwe;

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
  // FIX (2026-09-23, see conversation with Claude): the color strip used
  // to derive its LR from distPath[i]/distBenign[i] -- both are Gaussian
  // pdf() values, which underflow to exactly 0 once |x| is more than
  // ~38 SEs from a curve's own mean. For tight-SE variants (solved SEs as
  // small as 0.018-0.06 are common in production) the plotted x-range
  // legitimately reaches 40-90 SEs out, so BOTH pdfs hit 0 simultaneously,
  // making the ratio 0/0 = NaN. The Math.max/min clamp below did nothing
  // for that case (Math.min/max of NaN is NaN in JS), so lrToCategory's
  // isNaN guard silently painted a spurious gray "neutral" band into the
  // far tail of the strip where it should have stayed solid BVS/PVS.
  // Closed-form log-LR has no pdf() call and no exponential until the
  // very end, so it never underflows to 0/0 -- same formula as
  // regenerate_v3_binary.py/regenerate_v3_quant.py's solve_se everywhere.
  const lrCurve = xRange.map(x => {
    const xv   = isQuantitative ? x : Math.log(x);
    const muP  = isQuantitative ? pathOR : Math.log(pathOR);
    const logLR = muP * (2 * xv - muP) / (2 * se * se);
    return Math.exp(Math.max(-700, Math.min(700, logLR)));
  });
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

  // ---- Forest panel (top): gene anchor + observed variant, dot + 95% CI ----
  const forestLabels = [];
  const pathORCIValidFP = pathORLci != null && pathORUci != null && pathORUci > pathORLci;
  traces.push({
    x: [pathOR], y: [2], mode: 'markers',
    error_x: pathORCIValidFP ? { type: 'data', symmetric: false,
      array: [pathORUci - pathOR], arrayminus: [pathOR - pathORLci], color: COLORS.PS, thickness: 1.6, width: 4 } : undefined,
    marker: { color: COLORS.PS, size: 10, symbol: 'circle' },
    xaxis: 'x3', yaxis: 'y3', showlegend: false, hoverinfo: 'skip', name: 'Gene anchor',
  });
  forestLabels.push({ x: pathOR, y: 2.35, text: 'Expected pathogenic effect' });

  if (orProxy != null) {
    const fpCIValid = lci != null && uci != null && (isQuantitative ? uci > lci : lci > 0 && uci > 0);
    traces.push({
      x: [orProxy], y: [1], mode: 'markers',
      error_x: fpCIValid ? { type: 'data', symmetric: false,
        array: [uci - orProxy], arrayminus: [orProxy - lci], color: '#000', thickness: 1.6, width: 4 } : undefined,
      marker: { color: '#000', size: 10, symbol: 'circle' },
      xaxis: 'x3', yaxis: 'y3', showlegend: false, hoverinfo: 'skip', name: 'Observed variant',
    });
    const displayNote = record._display_note === 'solved' ? ' (SE solved for display)'
      : record._display_note === 'nudged' ? ' (position and SE adjusted for display)' : '';
    forestLabels.push({ x: orProxy, y: 1.35, text: `Observed variant${displayNote}` });
  }

  if (orProxy != null) {
    const ptLabel = hasPoint
      ? (isQuantitative ? `Observed Effect = ${fmtNum(orProxy)}` : `Observed OR = ${fmtNum(orProxy)}`)
      : `CI midpoint = ${fmtNum(orProxy)} (point est. masked)`;

    // Single dot always, at the real observed position (never repositioned
    // to a category center) -- see conversation with Claude, 2026-09-22.
    // Previously showed two dots for tail-capped/downgraded variants (gray
    // "raw position" + black "assigned category", the latter moved to
    // findCategoryCenter); removed the second (moved) dot per explicit
    // decision, keeping only the real-position dot, now colored black
    // like the non-downgraded case.
    const hoverText = isDowngraded
      ? `${ptLabel}<br>Raw LR category (downgraded due to small sample; assigned: ${rwe})<extra></extra>`
      : `${ptLabel}<br>LR = ${lr != null ? fmtNum(lr) : '—'}<extra></extra>`;
    traces.push({ x: [orProxy], y: [0.5], mode: 'markers',
      marker: { color: '#111111', size: 12, symbol: 'circle', line: { color: '#111', width: 1.5 } },
      xaxis: 'x2', yaxis: 'y2', showlegend: false,
      hovertemplate: hoverText, name: 'Observed' });
  }

  if (orProxy != null) {
    traces.push({ x: [null], y: [null], mode: 'lines', line: { color: '#000', width: 2.5 },
      name: 'Observed Variant', showlegend: true, xaxis: 'x', yaxis: 'y' });
  }

  const PANEL_X_DOMAIN = [0.02, 1];

  // ---- Shapes ----
  const shapes = [];
  const benignX = isQuantitative ? 0 : 1;

  shapes.push({ type: 'line', xref: 'x', yref: 'y', x0: benignX, x1: benignX, y0: 0, y1: yMax * 0.95,
    line: { color: COLORS.BS, dash: 'dash', width: 1.5 } });
  shapes.push({ type: 'line', xref: 'x', yref: 'y', x0: pathOR, x1: pathOR, y0: 0, y1: yMax * 0.95,
    line: { color: 'rgba(233,131,157,0.55)', dash: 'dash', width: 1.5 } });

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

  const fmtLR = (v) => v < 0.001 ? v.toExponential(2) : v > 1e6 ? v.toExponential(2) : v.toPrecision(3);

  let annotText = null;
  if (lr != null) {
    if (isDowngraded && rwe) {
      // Unicode combining strikethrough (U+0336) for Plotly-safe rendering
      const rawCat = lrToCategory(lr);
      const struck = rawCat.split('').map(c => c + '\u0336').join('');
      const lrFmt = fmtLR(lr);
      annotText = `<b>LR = ${lrFmt}  <span style="color:${fadedColor}">${struck}</span> → ${rweLabel}</b>`;
    } else {
      const lrFmt = fmtLR(lr);
      annotText = `<b>LR = ${lrFmt} → ${rweLabel}</b>`;
    }
  }
  // Inline, next to the observed-variant line (almost touching it), halfway
  // up the density plot -- not a paper-corner badge.
  if (annotText && orProxy != null) {
    const annotX = isQuantitative ? orProxy + 0.018 * (axisXMax - axisXMin)
                                   : orProxy * Math.exp(0.018 * (axisXMax - axisXMin));
    annotations.push({ xref: 'x', yref: 'y', x: annotX, y: yMax * 0.5, text: annotText,
      showarrow: false, font: { size: 13, color: textColor }, bgcolor: resultColor,
      bordercolor: '#aaa', borderwidth: 1, borderpad: 6, xanchor: 'left', yanchor: 'middle' });
  }

  // Forest-panel row labels, centered directly above each dot/whisker.
  // Plotly's annotation positioning is unreliable when xref points at a
  // log-typed axis (mis-centers, or doesn't render at all, depending on
  // the Plotly.js version) -- confirmed by reproducing it directly. To
  // sidestep that, the paper x-fraction is computed here from the same
  // axisXMin/axisXMax/PANEL_X_DOMAIN used for the real x3 axis, instead of
  // letting Plotly transform a data-space x through the log x3 axis.
  const toPaperX = (v) => {
    const dataPos = isQuantitative ? v : Math.log(v);
    const frac = (dataPos - axisXMin) / (axisXMax - axisXMin);
    return PANEL_X_DOMAIN[0] + frac * (PANEL_X_DOMAIN[1] - PANEL_X_DOMAIN[0]);
  };
  // Pick whichever of {left, center, right} the Plotly-native legend
  // overlaps least with the forest panel's two row labels ("Expected
  // pathogenic effect", "Observed variant..."). A fixed top-left legend
  // collided badly whenever a forest label sat near the left side of a
  // narrow x-axis range -- and a plain point-only check under-caught it
  // further when the label text itself was long (e.g. "Observed variant
  // (SE solved for display)"), since the text extends well beyond its
  // center anchor. So: measure each label's actual rendered text width
  // (Canvas measureText, not a per-character guess) to get its true
  // occupied paper-x span, and score all 3 candidate legend positions by
  // total overlap against those spans. The error bar itself is not
  // counted -- a thin whisker line passing near the legend is a minor
  // cosmetic issue, unlike two text labels actually overlapping.
  // See conversation with Claude, 2026-09-22.
  const plotWidthPx = Math.max(plotContainer.getBoundingClientRect().width || 0, plotContainer.offsetWidth || 0, 900);
  // Exact rendered pixel width via Canvas measureText, rather than a rough
  // per-character guess -- text length in characters is a poor proxy since
  // it ignores font metrics (e.g. narrow vs wide characters, parens/digits).
  const _measureCtx = document.createElement('canvas').getContext('2d');
  const textWidthPaper = (text, fontPx) => {
    _measureCtx.font = `${fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    return _measureCtx.measureText(text).width / plotWidthPx;
  };

  const labelSpan = (centerPaperX, text) => {
    const halfTextWidth = textWidthPaper(text, 11.5) / 2;
    return [centerPaperX - halfTextWidth, centerPaperX + halfTextWidth];
  };

  const forestSpans = [];
  forestSpans.push(labelSpan(toPaperX(pathOR), 'Expected pathogenic effect'));
  if (orProxy != null) {
    const displayNote = record._display_note === 'solved' ? ' (SE solved for display)'
      : record._display_note === 'nudged' ? ' (position and SE adjusted for display)' : '';
    forestSpans.push(labelSpan(toPaperX(orProxy), `Observed variant${displayNote}`));
  }

  // Legend box width: swatch/line icon + gap + widest entry text + padding,
  // measured the same way (font size 11, matching the legend's own config).
  const ICON_AND_PADDING_PAPER = 55 / plotWidthPx;
  const legendMaxTextWidth = Math.max(
    textWidthPaper(benignLegend, 11), textWidthPaper(pathLegend, 11), textWidthPaper('Observed Variant', 11));
  const legendHalfWidth = (ICON_AND_PADDING_PAPER + legendMaxTextWidth) / 2;
  const legendCandidates = [
    { x: 0.02, xanchor: 'left',   left: 0.02, right: 0.02 + 2 * legendHalfWidth },
    { x: 0.5,  xanchor: 'center', left: 0.5 - legendHalfWidth, right: 0.5 + legendHalfWidth },
    { x: 0.98, xanchor: 'right',  left: 0.98 - 2 * legendHalfWidth, right: 0.98 },
  ];
  const overlapAmount = (cand) => forestSpans.reduce((sum, [lo, hi]) =>
    sum + Math.max(0, Math.min(cand.right, hi) - Math.max(cand.left, lo)), 0);
  const bestLegendPos = legendCandidates.reduce((best, cand) =>
    overlapAmount(cand) < overlapAmount(best) - 1e-9 ? cand : best, legendCandidates[0]);

  forestLabels.forEach(fl => {
    annotations.push({ xref: 'paper', yref: 'y3', x: toPaperX(fl.x), y: fl.y, text: fl.text,
      showarrow: false, font: { size: 11.5, color: '#333' }, align: 'center', xanchor: 'center', yanchor: 'bottom' });
  });

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
        zeroline: true, zerolinecolor: '#ccc', zerolinewidth: 1, domain: PANEL_X_DOMAIN, anchor: 'y' }
    : { type: 'log', range: [axisXMin / Math.LN10, axisXMax / Math.LN10],
        tickvals: xTickVals, ticktext: xTickText, showgrid: true, gridcolor: '#eee',
        title: { text: xAxisTitle, font: { size: 13, color: '#333' }, standoff: 8 },
        zeroline: false, domain: PANEL_X_DOMAIN, anchor: 'y' };

  const xAxis2Cfg = isQuantitative
    ? { type: '-', range: [axisXMin, axisXMax], showticklabels: false,
        showgrid: false, zeroline: false, domain: PANEL_X_DOMAIN, anchor: 'y2' }
    : { type: 'log', range: [axisXMin / Math.LN10, axisXMax / Math.LN10],
        tickvals: xTickVals, ticktext: xTickText, showticklabels: false,
        showgrid: false, zeroline: false, domain: PANEL_X_DOMAIN, anchor: 'y2' };

  const xAxis3Cfg = isQuantitative
    ? { type: '-', range: [axisXMin, axisXMax], showticklabels: false,
        showgrid: false, zeroline: false, domain: PANEL_X_DOMAIN, anchor: 'y3' }
    : { type: 'log', range: [axisXMin / Math.LN10, axisXMax / Math.LN10],
        showticklabels: false, showgrid: false, zeroline: false, domain: PANEL_X_DOMAIN, anchor: 'y3' };

  const titleText = `Likelihood Ratio Framework — <b>${gene}</b> (${phenotype}${isQuantitative ? ', Effect Size' : ''})`;
  const layout = {
    height: 620,
    width: Math.max(plotContainer.getBoundingClientRect().width || 0, plotContainer.offsetWidth || 0, 900),
    margin: { t: 48, r: 40, b: 20, l: 60 },
    plot_bgcolor: '#fff',
    paper_bgcolor: '#fff',
    font: { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', size: 12 },
    xaxis:  xAxisCfg,
    yaxis:  { range: [0, yMax], title: { text: 'Probability Density', font: { size: 13, color: '#333' }, standoff: 6 },
              showgrid: true, gridcolor: '#eee', domain: [0.26, 0.78], anchor: 'x' },
    xaxis2: xAxis2Cfg,
    yaxis2: { range: [0, 1], domain: [0.06, 0.20], showticklabels: false,
              showgrid: false, zeroline: false, anchor: 'x2' },
    xaxis3: xAxis3Cfg,
    yaxis3: { range: [0.3, 2.7], domain: [0.86, 1.0], showticklabels: false,
              showgrid: false, zeroline: false, anchor: 'x3' },
    title:  { text: titleText, font: { size: 15, color: '#1a1d2e' }, x: 0.04, xanchor: 'left' },
    shapes,
    annotations,
    showlegend: true,
    legend: { x: bestLegendPos.x, y: 0.97, xanchor: bestLegendPos.xanchor, yanchor: 'top',
              bgcolor: 'rgba(255,255,255,0.85)', bordercolor: '#ddd', borderwidth: 1, font: { size: 11 } },
  };

  // Downgrade note
  const dnNote = document.getElementById('downgrade-note');
  if (isDowngraded) {
    dnNote.textContent =
      `Note: This variant's LR was downgraded from its raw score due to a small sample size. ` +
      `The dot shows the observed LR's true position on the evidence scale; ` +
      `the strikethrough category above it shows the raw category before downgrading to the assigned category.`;
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
