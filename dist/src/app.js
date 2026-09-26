/*
 * app.js — 画布交互（关键帧/标记点/保护矩形的拖动与录入）、实时精确校核与证据展示。
 * 任何编辑都会立即重新校核：遮挡校核（视线不得穿过或相切保护矩形）与
 * 跟踪角速度校核（ω=|d×v|/|d|²，平方精确比较，连续非抽样）同时生效；
 * 相机经过标记（视线方向未定义）同样判为不可执行。未设 ωmax 的历史标记只做遮挡校核。
 */
(function () {
  'use strict';
  const Geo = window.Geo;
  const Validate = window.Validate;
  const W = 960, H = 600;

  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  const $ = (id) => document.getElementById(id);
  const els = {
    verdict: $('verdict'), errors: $('errors'), evidence: $('evidence'), report: $('report'),
    keyList: $('keyList'), markerList: $('markerList'), rectList: $('rectList'),
    scrub: $('scrubT'), scrubLabel: $('scrubLabel'), scrubBox: $('scrubBox'),
    scrubMarks: $('scrubMarks'), hint: $('hint'),
  };

  let uid = 1;
  let drag = null;
  const state = {
    mode: 'select', keyframes: [], markers: [], rects: [],
    selected: null, result: null, parsed: null, errors: [], scrub: 0,
  };

  /* ---------------- 工具 ---------------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (f) => Geo.fmt(f);
  const fmtP = (p) => `(${fmt(p.x)}, ${fmt(p.y)})`;
  const numX = (x) => (typeof x.toNumber === 'function' ? x.toNumber() : x); // Frac 或 Root
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function hint(msg) {
    els.hint.textContent = msg;
    if (msg) setTimeout(() => { if (els.hint.textContent === msg) els.hint.textContent = ''; }, 3500);
  }
  const findItem = (kind, id) => {
    const arr = kind === 'keyframe' ? state.keyframes : kind === 'marker' ? state.markers : state.rects;
    return arr.find((a) => a.id === id);
  };

  /* ---------------- 校核 ---------------- */
  const rawFromState = () => ({
    keyframes: state.keyframes.map((k) => ({ tStr: k.tStr, x: k.x, y: k.y })),
    markers: state.markers.map((m) => ({ x: m.x, y: m.y, wMaxStr: m.wMaxStr })),
    rects: state.rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
  });

  function recheck() {
    const v = Validate.scenario(rawFromState(), { width: W, height: H });
    state.errors = v.errors;
    state.parsed = v.parsed;
    state.result = v.parsed ? Geo.checkScenario(v.parsed) : null;
    if (state.result && state.result.firstViolation) {
      // 把时间轴定位到最早不可执行时刻，让摄影师立即看到首个依据
      const r = state.result, span = r.t1.sub(r.t0);
      const fv = r.firstViolation;
      let scrub = span.isZero() ? 0 : (numX(fv.t) - r.t0.toNumber()) / span.toNumber();
      // 超限首项是开区间端点（端点本身 ω≡限值，不超限）：向区间内微偏 1 个滑块刻度，
      // 使画布视线立即呈现超限紫色，与证据卡一致；区间过窄时取中点。
      if (fv.kind === 'angular') {
        const half = Math.max(0, numX(fv.tEnd) - numX(fv.t)) / (2 * span.toNumber());
        scrub += Math.min(0.0002, half);
      }
      state.scrub = clamp(scrub, 0, 1);
      els.scrub.value = String(Math.round(state.scrub * 10000));
    }
    renderPanels();
    draw();
  }

  // 时间轴当前对应的精确时刻
  function scrubT() {
    const ks = state.parsed.keyframes;
    const t0 = ks[0].t, t1 = ks[ks.length - 1].t;
    const v = new Geo.Frac(BigInt(Math.round(state.scrub * 10000)), 10000n);
    return t0.add(t1.sub(t0).mul(v));
  }

  // 某一精确时刻的相机位置与各视线的遮挡/角速度情况（连续判定的逐点版本，仍非抽样枚举）
  function instantInfo(t) {
    const ks = state.parsed.keyframes;
    let i = ks.length - 2;
    for (let s = 0; s < ks.length - 1; s++) { if (t.cmp(ks[s + 1].t) <= 0) { i = s; break; } }
    const t0 = ks[i].t, t1 = ks[i + 1].t;
    const span = t1.sub(t0);
    const u = t1.gt(t0) ? t.sub(t0).div(t1.sub(t0)) : new Geo.Frac(0n);
    const C = Geo.cameraAt(ks[i].p, ks[i + 1].p, u);
    const lines = state.parsed.markers.map((M, mi) => {
      const hits = [];
      state.parsed.rects.forEach((R, ri) => { if (Geo.sweepInterval(C, C, M, R)) hits.push(ri); });
      // 瞬时跟踪角速度：ω=|d×v|/|d|²，用平方精确比较 ω² 与 L²，不抽样
      const L = state.parsed.limits ? state.parsed.limits[mi] : null;
      let ang = null;
      if (L) {
        const vx = ks[i + 1].p.x.sub(ks[i].p.x).div(span);
        const vy = ks[i + 1].p.y.sub(ks[i].p.y).div(span);
        const dx = M.x.sub(C.x), dy = M.y.sub(C.y);
        const q = dx.mul(dx).add(dy.mul(dy));
        if (q.isZero()) ang = { kind: 'undef' }; // 相机经过标记：方向未定义
        else {
          const s = dx.mul(vy).sub(dy.mul(vx));
          const over = s.mul(s).gt(L.mul(L).mul(q).mul(q)); // s² > L²·q² ⟺ ω > L
          ang = { kind: over ? 'over' : 'ok', omega: (s.n < 0n ? s.neg() : s).div(q) };
        }
      }
      return { mi, M, hits, ang };
    });
    return { C, lines, segIndex: i, u };
  }

  /* ---------------- 面板渲染 ---------------- */
  function renderPanels() {
    const v = els.verdict;
    if (state.errors.length) { v.className = 'verdict invalid'; v.textContent = '配置无效，无法校核'; }
    else if (!state.result) { v.className = 'verdict pending'; v.textContent = '待校核'; }
    else if (state.result.ok) { v.className = 'verdict ok'; v.textContent = '✓ 校核通过：全程无遮挡且跟踪角速度合规，曝光可执行'; }
    else { v.className = 'verdict bad'; v.textContent = '✗ 该次曝光不可执行（遮挡 / 跟踪超限 / 方向失效）'; }

    els.errors.innerHTML = state.errors.map((e) => `<div class="err">• ${esc(e)}</div>`).join('');
    renderEvidence();
    renderReport();
    renderTrackMarks();
    els.scrubBox.style.display = state.parsed && state.parsed.keyframes.length >= 2 ? '' : 'none';
    updateScrubLabel();
  }

  const segHead = (seg) =>
    `航段：K${seg.index + 1} → K${seg.index + 2}（t ∈ [${esc(fmt(seg.t0))}, ${esc(fmt(seg.t1))}]）`;

  function renderEvidence() {
    const r = state.result;
    if (!r || !r.firstViolation) { els.evidence.innerHTML = ''; return; }
    const f = r.firstViolation;
    const seg = r.segments[f.segmentIndex];
    const M = state.parsed.markers[f.markerIndex];
    let body = '';
    if (f.kind === 'occlusion') {
      const R = state.parsed.rects[f.rectIndex];
      body = `
        <h3>最早遮挡证据（可复核）</h3>
        <ul>
          <li>时刻：<b>t = ${esc(Geo.fmtFull(f.t))}</b>${f.tangent
            ? '（<b>相切</b>：首次擦到保护边界）'
            : `（进入遮挡区间 [${esc(fmt(f.t))}, ${esc(fmt(f.tMax))}]）`}</li>
          <li>${segHead(seg)}</li>
          <li>标记点：M${f.markerIndex + 1} ${esc(fmtP(M))}</li>
          <li>保护矩形：R${f.rectIndex + 1}　x∈[${esc(fmt(R.x1))}, ${esc(fmt(R.x2))}]，y∈[${esc(fmt(R.y1))}, ${esc(fmt(R.y2))}]</li>
          <li>相机位置：C(t) = ${esc(fmtP(f.camera))}</li>
          <li>接触点（在矩形边界上）：${esc(fmtP(f.contact))}</li>
        </ul>
        <p class="note">画布已用红色虚线绘制该时刻的相机位置、视线与接触点；拖动时间轴可逐时刻复核。</p>`;
    } else if (f.kind === 'angular') {
      const brL = (x, closed) => `${closed ? '[' : '('}${esc(Geo.fmtTime(x))}`;
      const brR = (x, closed) => `${esc(Geo.fmtTime(x))}${closed ? ']' : ')'}`;
      body = `
        <h3>最早跟踪角速度超限证据（连续精确判定，非抽样）</h3>
        <ul>
          <li>时刻：<b>t = ${esc(Geo.fmtTime(f.t))}</b>（ω 首次触及限值，进入超限区间）</li>
          <li>${segHead(seg)}</li>
          <li>标记点：M${f.markerIndex + 1} ${esc(fmtP(M))}</li>
          <li>限值：ωmax = <b>${esc(Geo.fmtFull(f.limit))}</b> rad/时间单位（速度平方与限值平方精确比较）</li>
          <li>超限区间：${brL(f.t, f.loClosed)}, ${brR(f.tEnd, f.hiClosed)}（开区间端点为 ω≡ωmax 的相切时刻）</li>
          <li>该区间实际角速度上确界：ωmax实际 = <b>${esc(Geo.fmtFull(f.omegaMax))}</b>（&gt; ${esc(fmt(f.limit))}）</li>
          <li>进入超限时相机位置：C(t) = ${esc(Geo.fmtRootPt(f.camera))}</li>
          <li>角速度峰值时刻：t = ${esc(Geo.fmtFull(f.peakT))}，相机 C = ${esc(Geo.fmtRootPt(f.peakCamera))}</li>
        </ul>
        <p class="note">视线未触及任何保护矩形也会判不可执行；紫色虚线绘制进入超限时的视线，时间轴已标出超限区间。</p>`;
    } else {
      body = `
        <h3>视线方向失效证据（相机经过标记点）</h3>
        <ul>
          <li>时刻：<b>t = ${esc(Geo.fmtFull(f.t))}</b>（相机与标记重合，激光对焦方向未定义）</li>
          <li>${segHead(seg)}</li>
          <li>标记点：M${f.markerIndex + 1} ${esc(fmtP(M))}</li>
          <li>相机位置：C(t) = ${esc(fmtP(f.camera))}（= 标记点）</li>
        </ul>
        <p class="note">方向未定义时刻不可执行：瞬时角速度 |d×v|/|d|² 发散，无法跟踪。</p>`;
    }
    els.evidence.innerHTML = `<div class="card danger">${body}</div>`;
  }

  function renderReport() {
    const r = state.result;
    if (!r) { els.report.innerHTML = '<p class="muted">完成有效配置后，此处自动给出每个航段、每条视线的安全区间。</p>'; return; }
    const iv = (s) => `${s.fromClosed ? '[' : '('}${esc(fmt(s.from))}, ${esc(fmt(s.to))}${s.toClosed ? ']' : ')'}`;
    const ivA = (ex) => `${ex.loClosed ? '[' : '('}${esc(Geo.fmtTime(ex.tLo))}, ${esc(Geo.fmtTime(ex.tHi))}${ex.hiClosed ? ']' : ')'}`;
    els.report.innerHTML = r.segments.map((seg) => {
      const rows = seg.byMarker.map((bm) => {
        let line;
        if (!bm.occluded.length) line = `<div class="row ok">M${bm.markerIndex + 1}：全程安全</div>`;
        else {
          const occ = bm.occluded.map((o) => {
            const rs = o.rects.map((ri) => `R${ri + 1}`).join('/');
            return o.tangent
              ? `相切于 t = ${esc(fmt(o.tMin))}（${rs}）`
              : `遮挡 [${esc(fmt(o.tMin))}, ${esc(fmt(o.tMax))}]（${rs}）`;
          }).join('；');
          const safe = bm.safe.length ? bm.safe.map(iv).join(' ∪ ') : '无';
          line = `<div class="row bad">M${bm.markerIndex + 1}：${occ}<br><span class="safe">安全区间：${safe}</span></div>`;
        }
        const ang = seg.angByMarker[bm.markerIndex];
        if (ang && ang.limit) {
          const ex = ang.exceed.map((x) =>
            `角速度超限 ${ivA(x)}（ω 峰值 ${esc(fmt(x.omegaMax))} &gt; ${esc(fmt(x.limit))}）`).join('；');
          const ud = ang.undefined.map((x) => `方向失效于 t = ${esc(fmt(x.t))}`).join('；');
          const parts = [];
          if (!ang.exceed.length && !ang.undefined.length)
            parts.push(`<span class="ang-ok">ωmax=${esc(fmt(ang.limit))}：全程 ≤ 限值</span>`);
          if (ex) parts.push(`<span class="ang-bad">${ex}</span>`);
          if (ud) parts.push(`<span class="ang-bad">${ud}</span>`);
          line += `<div class="row ang">跟踪校核（ωmax=${esc(fmt(ang.limit))}）：${parts.join('；')}</div>`;
        }
        return line;
      }).join('');
      return `<div class="seg"><h4>航段 K${seg.index + 1} → K${seg.index + 2}（t ∈ [${esc(fmt(seg.t0))}, ${esc(fmt(seg.t1))}]）</h4>${rows}</div>`;
    }).join('');
  }

  // 时间轴区间标记：红=遮挡闭区间，紫=角速度超限开区间，黄竖线=方向失效时刻
  function renderTrackMarks() {
    const r = state.result;
    if (!r || !els.scrubMarks) { if (els.scrubMarks) els.scrubMarks.innerHTML = ''; return; }
    const span = r.t1.sub(r.t0);
    const pos = (t) => `${clamp((numX(t) - r.t0.toNumber()) / span.toNumber() * 100, 0, 100)}%`;
    const bars = [];
    for (const seg of r.segments) {
      for (const bm of seg.byMarker) for (const o of bm.occluded) {
        const a = pos(o.tMin), b = pos(o.tMax);
        bars.push(`<span class="occ" style="left:${a};width:calc(${b} - ${a})" title="遮挡 M${bm.markerIndex + 1} [${esc(fmt(o.tMin))}, ${esc(fmt(o.tMax))}]"></span>`);
      }
      for (const ang of seg.angByMarker) {
        for (const x of ang.exceed) {
          const a = pos(x.tLo), b = pos(x.tHi);
          bars.push(`<span class="ang" style="left:${a};width:calc(${b} - ${a})" title="角速度超限 M${ang.markerIndex + 1}"></span>`);
        }
        for (const x of ang.undefined) {
          bars.push(`<span class="undef" style="left:${pos(x.t)}" title="方向失效 M${ang.markerIndex + 1} t=${esc(fmt(x.t))}"></span>`);
        }
      }
    }
    els.scrubMarks.innerHTML = bars.join('');
  }

  function renderLists() {
    const selCls = (kind, id) => (state.selected && state.selected.kind === kind && state.selected.id === id ? 'sel' : '');
    els.keyList.innerHTML = state.keyframes.map((k, i) => `
      <div class="item ${selCls('keyframe', k.id)}">
        <span class="tag">K${i + 1}</span>
        <label>t <input data-kind="keyframe" data-id="${k.id}" data-field="tStr" value="${esc(k.tStr)}"></label>
        <label>x <input type="number" data-kind="keyframe" data-id="${k.id}" data-field="x" value="${k.x}"></label>
        <label>y <input type="number" data-kind="keyframe" data-id="${k.id}" data-field="y" value="${k.y}"></label>
        <button type="button" data-act="del" data-kind="keyframe" data-id="${k.id}" title="删除">×</button>
      </div>`).join('');
    els.markerList.innerHTML = state.markers.map((m, i) => `
      <div class="item ${selCls('marker', m.id)}">
        <span class="tag tag-m">M${i + 1}</span>
        <label>x <input type="number" data-kind="marker" data-id="${m.id}" data-field="x" value="${m.x}"></label>
        <label>y <input type="number" data-kind="marker" data-id="${m.id}" data-field="y" value="${m.y}"></label>
        <label title="最大跟踪角速度 ωmax（rad/时间单位，正数；留空不限制）">ωmax <input class="winp" data-kind="marker" data-id="${m.id}" data-field="wMaxStr" value="${esc(m.wMaxStr || '')}" placeholder="留空"></label>
        <button type="button" data-act="del" data-kind="marker" data-id="${m.id}" title="删除">×</button>
      </div>`).join('');
    els.rectList.innerHTML = state.rects.map((r, i) => `
      <div class="item ${selCls('rect', r.id)}">
        <span class="tag tag-r">R${i + 1}</span>
        <label>x <input type="number" data-kind="rect" data-id="${r.id}" data-field="x" value="${r.x}"></label>
        <label>y <input type="number" data-kind="rect" data-id="${r.id}" data-field="y" value="${r.y}"></label>
        <label>宽 <input type="number" data-kind="rect" data-id="${r.id}" data-field="w" value="${r.w}"></label>
        <label>高 <input type="number" data-kind="rect" data-id="${r.id}" data-field="h" value="${r.h}"></label>
        <button type="button" data-act="del" data-kind="rect" data-id="${r.id}" title="删除">×</button>
      </div>`).join('');
  }

  // 拖动时同步右侧面板数值（不重渲染列表，避免输入框失焦）
  function syncInputs() {
    document.querySelectorAll('aside input[data-field]').forEach((inp) => {
      if (inp.dataset.field === 'tStr' || inp.dataset.field === 'wMaxStr' || document.activeElement === inp) return;
      const it = findItem(inp.dataset.kind, Number(inp.dataset.id));
      if (it) inp.value = it[inp.dataset.field];
    });
  }

  function updateScrubLabel() {
    if (!state.parsed || state.parsed.keyframes.length < 2) { els.scrubLabel.textContent = ''; return; }
    const t = scrubT();
    const info = instantInfo(t);
    const notes = [];
    const occ = info.lines.filter((l) => l.hits.length);
    if (occ.length) notes.push('⚠ 遮挡：' + occ.map((l) => `M${l.mi + 1}×${l.hits.map((r) => 'R' + (r + 1)).join('/')}`).join('，'));
    const undef = info.lines.filter((l) => l.ang && l.ang.kind === 'undef');
    if (undef.length) notes.push('⛝ 方向失效：' + undef.map((l) => `M${l.mi + 1}`).join('，'));
    const over = info.lines.filter((l) => l.ang && l.ang.kind === 'over');
    if (over.length) notes.push('↻ 角速度超限：' + over.map((l) => `M${l.mi + 1}(ω=${fmt(l.ang.omega)})`).join('，'));
    const tail = notes.length ? '　' + notes.join('　') : '　✓ 此时刻全部视线安全且跟踪合规';
    els.scrubLabel.textContent = `t = ${Geo.fmtFull(t)}（航段 K${info.segIndex + 1}→K${info.segIndex + 2}）` + tail;
  }

  /* ---------------- 画布绘制 ---------------- */
  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawGrid();
    drawPath();
    state.rects.forEach((r, i) => drawRect(r, i));
    drawAllContacts();
    drawScrubLines();
    state.markers.forEach((m, i) => drawMarker(m, i));
    state.keyframes.forEach((k, i) => drawKey(k, i));
    drawEvidence();
    if (drag && drag.type === 'create') drawGhostRect(drag);
  }

  function drawGrid() {
    ctx.save();
    ctx.strokeStyle = '#1b222b'; ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 40) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
    ctx.restore();
  }

  function drawPath() {
    const ks = state.keyframes;
    if (ks.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#4da3ff'; ctx.fillStyle = '#4da3ff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(ks[0].x, ks[0].y);
    for (let i = 1; i < ks.length; i++) ctx.lineTo(ks[i].x, ks[i].y);
    ctx.stroke(); ctx.setLineDash([]);
    for (let i = 1; i < ks.length; i++) {
      const a = ks[i - 1], b = ks[i], ang = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.beginPath(); ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - 10 * Math.cos(ang - 0.4), b.y - 10 * Math.sin(ang - 0.4));
      ctx.lineTo(b.x - 10 * Math.cos(ang + 0.4), b.y - 10 * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function drawKey(k, i) {
    const sel = state.selected && state.selected.kind === 'keyframe' && state.selected.id === k.id;
    ctx.save();
    ctx.beginPath(); ctx.arc(k.x, k.y, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#4da3ff'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = sel ? '#ffd84d' : '#0b1521'; ctx.stroke();
    ctx.fillStyle = '#0b1521'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`K${i + 1}`, k.x, k.y);
    ctx.fillStyle = '#9fc7ff'; ctx.font = '11px sans-serif'; ctx.textBaseline = 'top';
    ctx.fillText(`t=${k.tStr}`, k.x, k.y + 14);
    ctx.restore();
  }

  function drawMarker(m, i) {
    const sel = state.selected && state.selected.kind === 'marker' && state.selected.id === m.id;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(m.x, m.y - 9); ctx.lineTo(m.x + 9, m.y); ctx.lineTo(m.x, m.y + 9); ctx.lineTo(m.x - 9, m.y);
    ctx.closePath();
    ctx.fillStyle = '#ffb84d'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = sel ? '#ffffff' : '#5a3d00'; ctx.stroke();
    ctx.fillStyle = '#ffd9a0'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(`M${i + 1}`, m.x, m.y - 12);
    ctx.restore();
  }

  function drawRect(r, i) {
    const sel = state.selected && state.selected.kind === 'rect' && state.selected.id === r.id;
    ctx.save();
    ctx.fillStyle = 'rgba(255,90,90,0.14)'; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.lineWidth = 2; ctx.strokeStyle = sel ? '#ffd84d' : '#ff5a5a'; ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#ff8a8a'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(`R${i + 1}`, r.x + 4, r.y + 4);
    if (sel) { ctx.fillStyle = '#ffd84d'; ctx.fillRect(r.x + r.w - 4, r.y + r.h - 4, 8, 8); }
    ctx.restore();
  }

  function drawAllContacts() {
    const r = state.result;
    if (!r) return;
    ctx.save(); ctx.fillStyle = 'rgba(255,90,90,0.9)';
    for (const seg of r.segments) for (const e of seg.entries) {
      ctx.beginPath(); ctx.arc(e.contactMin.x.toNumber(), e.contactMin.y.toNumber(), 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawScrubLines() {
    if (!state.parsed || state.parsed.keyframes.length < 2) return;
    const info = instantInfo(scrubT());
    const cx = info.C.x.toNumber(), cy = info.C.y.toNumber();
    ctx.save();
    for (const ln of info.lines) {
      let color = '#3fbf6f', width = 1.2;
      if (ln.hits.length) { color = '#ff5a5a'; width = 2; }
      else if (ln.ang && ln.ang.kind === 'undef') { color = '#ffd84d'; width = 2; }
      else if (ln.ang && ln.ang.kind === 'over') { color = '#c78bff'; width = 2; }
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ln.M.x.toNumber(), ln.M.y.toNumber()); ctx.stroke();
      if (ln.ang && ln.ang.kind === 'over') { // 标出当前实际角速度
        ctx.fillStyle = '#c78bff'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const mx = (cx + ln.M.x.toNumber()) / 2, my = (cy + ln.M.y.toNumber()) / 2;
        ctx.fillText(`ω=${fmt(ln.ang.omega)}`, mx + 3, my - 7);
      }
    }
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('C(t)', cx, cy - 10);
    ctx.restore();
  }

  function drawEvidence() {
    const r = state.result;
    if (!r || !r.firstViolation) return;
    const f = r.firstViolation;
    const M = state.parsed.markers[f.markerIndex];
    const cx = numX(f.camera.x), cy = numX(f.camera.y);
    const mx = M.x.toNumber(), my = M.y.toNumber();
    ctx.save();
    if (f.kind === 'occlusion') {
      const px = f.contact.x.toNumber(), py = f.contact.y.toNumber();
      ctx.strokeStyle = '#ff5a5a'; ctx.lineWidth = 2.5; ctx.setLineDash([8, 5]);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(mx, my); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.strokeStyle = '#ff5a5a'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.strokeStyle = '#ffd84d'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px - 9, py); ctx.lineTo(px + 9, py); ctx.moveTo(px, py - 9); ctx.lineTo(px, py + 9);
      ctx.stroke();
      ctx.fillStyle = '#ffd84d'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`首次遮挡 t=${fmt(f.t)}`, clamp(px + 10, 4, W - 130), clamp(py - 10, 14, H - 4));
    } else if (f.kind === 'angular') {
      ctx.strokeStyle = '#c78bff'; ctx.lineWidth = 2.5; ctx.setLineDash([8, 5]);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(mx, my); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.strokeStyle = '#c78bff'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.fillStyle = '#d9b3ff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`跟踪超限起始 t=${Geo.fmtTime(f.t)}`, clamp(cx + 10, 4, W - 200), clamp(cy - 12, 14, H - 4));
      ctx.font = '11px sans-serif';
      ctx.fillText(`ω=${fmt(f.omegaAt)} 起，峰值 ${fmt(f.omegaMax)}`, clamp(cx + 10, 4, W - 200), clamp(cy + 4, 14, H - 4));
    } else {
      ctx.strokeStyle = '#ffd84d'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(cx, cy, 11, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy); ctx.lineTo(cx + 9, cy); ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy + 9);
      ctx.stroke();
      ctx.fillStyle = '#ffd84d'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`方向失效 t=${fmt(f.t)}`, clamp(cx + 14, 4, W - 150), clamp(cy - 12, 14, H - 4));
    }
    ctx.restore();
  }

  function drawGhostRect(d) {
    const x = Math.min(d.anchor.x, d.cur.x), y = Math.min(d.anchor.y, d.cur.y);
    const w = Math.abs(d.anchor.x - d.cur.x), h = Math.abs(d.anchor.y - d.cur.y);
    ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = '#ff5a5a'; ctx.strokeRect(x, y, w, h); ctx.restore();
  }

  /* ---------------- 画布交互 ---------------- */
  function canvasPos(e) {
    const r = cv.getBoundingClientRect();
    return {
      x: clamp(Math.round((e.clientX - r.left) * W / r.width), 0, W),
      y: clamp(Math.round((e.clientY - r.top) * H / r.height), 0, H),
    };
  }

  function hitTest(p) {
    if (state.selected && state.selected.kind === 'rect') {
      const r = findItem('rect', state.selected.id);
      if (r && Math.abs(p.x - (r.x + r.w)) <= 8 && Math.abs(p.y - (r.y + r.h)) <= 8) return { kind: 'rect-handle', id: r.id };
    }
    for (let i = state.keyframes.length - 1; i >= 0; i--) {
      const k = state.keyframes[i];
      if (Math.hypot(p.x - k.x, p.y - k.y) <= 12) return { kind: 'keyframe', id: k.id };
    }
    for (let i = state.markers.length - 1; i >= 0; i--) {
      const m = state.markers[i];
      if (Math.hypot(p.x - m.x, p.y - m.y) <= 10) return { kind: 'marker', id: m.id };
    }
    for (let i = state.rects.length - 1; i >= 0; i--) {
      const r = state.rects[i];
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return { kind: 'rect', id: r.id };
    }
    return null;
  }

  cv.addEventListener('pointerdown', (e) => {
    const p = canvasPos(e);
    cv.setPointerCapture(e.pointerId);
    if (state.mode === 'keyframe') {
      if (state.keyframes.length >= 4) return hint('最多 4 个相机关键帧');
      state.keyframes.push({ id: uid++, tStr: defaultTime(), x: p.x, y: p.y });
      renderLists(); recheck(); return;
    }
    if (state.mode === 'marker') {
      if (state.markers.length >= 6) return hint('最多 6 个标记点');
      state.markers.push({ id: uid++, x: p.x, y: p.y, wMaxStr: '' });
      renderLists(); recheck(); return;
    }
    if (state.mode === 'rect') {
      if (state.rects.length >= 4) return hint('最多 4 个保护矩形');
      drag = { type: 'create', anchor: p, cur: p }; return;
    }
    const hit = hitTest(p);
    if (hit) {
      state.selected = { kind: hit.kind === 'rect-handle' ? 'rect' : hit.kind, id: hit.id };
      drag = hit.kind === 'rect-handle'
        ? { type: 'resize', id: hit.id }
        : { type: 'move', kind: hit.kind, id: hit.id, last: p };
    } else {
      state.selected = null;
    }
    renderLists(); draw();
  });

  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = canvasPos(e);
    if (drag.type === 'create') { drag.cur = p; draw(); return; }
    if (drag.type === 'move') {
      const it = findItem(drag.kind, drag.id);
      if (!it) return;
      const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
      drag.last = p;
      if (drag.kind === 'rect') { it.x = clamp(it.x + dx, 0, W - it.w); it.y = clamp(it.y + dy, 0, H - it.h); }
      else { it.x = clamp(it.x + dx, 0, W); it.y = clamp(it.y + dy, 0, H); }
      syncInputs(); recheck(); return;
    }
    if (drag.type === 'resize') {
      const r = findItem('rect', drag.id);
      if (!r) return;
      r.w = clamp(p.x - r.x, 8, W - r.x);
      r.h = clamp(p.y - r.y, 8, H - r.y);
      syncInputs(); recheck();
    }
  });

  cv.addEventListener('pointerup', () => {
    if (drag && drag.type === 'create') {
      const a = drag.anchor, b = drag.cur;
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
      if (w >= 8 && h >= 8) {
        const r = { id: uid++, x, y, w, h };
        state.rects.push(r);
        state.selected = { kind: 'rect', id: r.id };
      } else hint('矩形太小，未创建');
    }
    drag = null;
    renderLists(); recheck();
  });

  function defaultTime() {
    if (!state.keyframes.length) return '0';
    const last = state.keyframes[state.keyframes.length - 1];
    const t = Geo.tryParse(last.tStr);
    return t ? String(t.toNumber() + 1) : String((parseFloat(last.tStr) || 0) + 1);
  }

  /* ---------------- 工具栏与面板事件 ---------------- */
  function setMode(m) {
    state.mode = m;
    document.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('active', x.dataset.mode === m));
    cv.style.cursor = m === 'select' ? 'default' : 'crosshair';
    hint({
      keyframe: '在画布上点击放置相机关键帧（2–4 个）',
      marker: '在画布上点击放置标记点（2–6 个）',
      rect: '在画布上按住拖拽画出保护矩形（1–4 个）',
      select: '',
    }[m] || '');
  }
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  function deleteSelected() {
    const s = state.selected;
    if (!s) return;
    const arr = s.kind === 'keyframe' ? state.keyframes : s.kind === 'marker' ? state.markers : state.rects;
    const i = arr.findIndex((a) => a.id === s.id);
    if (i >= 0) arr.splice(i, 1);
    state.selected = null;
    renderLists(); recheck();
  }

  $('btnDelete').addEventListener('click', deleteSelected);
  $('btnClear').addEventListener('click', () => {
    state.keyframes = []; state.markers = []; state.rects = []; state.selected = null;
    renderLists(); recheck();
  });
  $('btnSample').addEventListener('click', loadSample);
  $('btnCheck').addEventListener('click', () => {
    recheck();
    hint(state.errors.length ? '请先修正配置错误'
      : state.result && state.result.ok ? '校核通过：无遮挡且跟踪角速度合规'
      : '校核完成：不可执行，最早依据见右侧面板');
  });
  els.scrub.addEventListener('input', () => {
    state.scrub = Number(els.scrub.value) / 10000;
    draw(); updateScrubLabel();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' && document.activeElement.tagName !== 'INPUT') deleteSelected();
    if (e.key === 'Escape') setMode('select');
  });

  document.querySelector('aside').addEventListener('input', (e) => {
    const d = e.target.dataset;
    if (!d.field) return;
    const it = findItem(d.kind, Number(d.id));
    if (!it) return;
    if (d.field === 'tStr' || d.field === 'wMaxStr') it[d.field] = e.target.value;
    else {
      const v = Math.round(Number(e.target.value));
      if (Number.isFinite(v)) it[d.field] = v;
    }
    recheck();
  });
  document.querySelector('aside').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.act !== 'del') return;
    const arr = b.dataset.kind === 'keyframe' ? state.keyframes : b.dataset.kind === 'marker' ? state.markers : state.rects;
    const i = arr.findIndex((a) => a.id === Number(b.dataset.id));
    if (i >= 0) arr.splice(i, 1);
    if (state.selected && state.selected.id === Number(b.dataset.id)) state.selected = null;
    renderLists(); recheck();
  });

  /* ---------------- 示例与初始化 ---------------- */
  function loadSample() {
    state.keyframes = [
      { tStr: '0', x: 60, y: 100 },
      { tStr: '4', x: 900, y: 100 },
      { tStr: '6', x: 900, y: 500 },
    ].map((k) => ({ id: uid++, ...k }));
    state.markers = [
      { x: 480, y: 400, wMaxStr: '0.3' },
      { x: 150, y: 520, wMaxStr: '' }, // 历史标记：留空，只做遮挡校核
    ].map((m) => ({ id: uid++, ...m }));
    state.rects = [
      { x: 380, y: 140, w: 200, h: 120 },
      { x: 700, y: 300, w: 120, h: 90 },
    ].map((r) => ({ id: uid++, ...r }));
    state.selected = null;
    renderLists(); recheck();
    hint('已载入示例：M1 设 ωmax=0.3（最早不可执行依据为跟踪超限），M2 留空；遮挡校核同时生效');
  }

  setMode('select');
  loadSample();
})();
