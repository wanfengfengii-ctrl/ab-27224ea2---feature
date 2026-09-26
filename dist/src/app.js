/*
 * app.js — 画布交互（关键帧/标记点/保护矩形的拖动与录入）、实时精确校核与证据展示。
 * 任何编辑都会立即重新校核：一旦移动中首次擦到保护边界，结论与首个遮挡证据即刻可见。
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
    scrub: $('scrubT'), scrubLabel: $('scrubLabel'), scrubBox: $('scrubBox'), hint: $('hint'),
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
    markers: state.markers.map((m) => ({ x: m.x, y: m.y, omegaStr: m.omegaStr })),
    rects: state.rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
  });

  const hasLimits = () => !!(state.parsed && state.parsed.limits && state.parsed.limits.some(Boolean));

  function recheck() {
    const v = Validate.scenario(rawFromState(), { width: W, height: H });
    state.errors = v.errors;
    state.parsed = v.parsed;
    state.result = v.parsed ? Geo.checkScenario(v.parsed) : null;
    if (state.result) {
      // 把时间轴定位到全程最早问题时刻（遮挡或跟踪超限，取更早者），让摄影师立即看到首项证据
      const r = state.result;
      let tAnchor = null;
      if (r.firstOcclusion) tAnchor = r.firstOcclusion.t.toNumber();
      if (r.firstAngular) {
        const ta = r.firstAngular.t.toNumber();
        if (tAnchor === null || ta < tAnchor) tAnchor = ta;
      }
      if (tAnchor !== null) {
        const span = r.t1.sub(r.t0);
        state.scrub = span.isZero() ? 0 : (tAnchor - r.t0.toNumber()) / span.toNumber();
        els.scrub.value = String(Math.round(state.scrub * 1000));
      }
    }
    renderPanels();
    draw();
  }

  // 时间轴当前对应的精确时刻
  function scrubT() {
    const ks = state.parsed.keyframes;
    const t0 = ks[0].t, t1 = ks[ks.length - 1].t;
    const v = new Geo.Frac(BigInt(Math.round(state.scrub * 1000)), 1000n);
    return t0.add(t1.sub(t0).mul(v));
  }

  // 某一精确时刻的相机位置与各视线的遮挡情况（连续判定的逐点版本，仍非抽样枚举）
  function instantInfo(t) {
    const ks = state.parsed.keyframes;
    let i = ks.length - 2;
    for (let s = 0; s < ks.length - 1; s++) { if (t.cmp(ks[s + 1].t) <= 0) { i = s; break; } }
    const t0 = ks[i].t, t1 = ks[i + 1].t;
    const u = t1.gt(t0) ? t.sub(t0).div(t1.sub(t0)) : new Geo.Frac(0n);
    const C = Geo.cameraAt(ks[i].p, ks[i + 1].p, u);
    const A = ks[i].p, B = ks[i + 1].p;
    const span = t1.sub(t0);
    const vx = B.x.sub(A.x), vy = B.y.sub(A.y);
    const limits = state.parsed.limits || [];
    const lines = state.parsed.markers.map((M, mi) => {
      const hits = [];
      state.parsed.rects.forEach((R, ri) => { if (Geo.sweepInterval(C, C, M, R)) hits.push(ri); });
      // 该时刻的跟踪角速度：ω² = c²/(Δt²·q²)，与限值平方精确比较
      let ang = null;
      const lim = limits[mi];
      if (lim) {
        const rx = M.x.sub(C.x), ry = M.y.sub(C.y);
        const q = rx.mul(rx).add(ry.mul(ry));
        if (q.isZero()) {
          ang = { undefined: true };
        } else {
          const c = vx.mul(M.y.sub(A.y)).sub(vy.mul(M.x.sub(A.x)));
          const omega2 = c.mul(c).div(q.mul(q).mul(span).mul(span));
          ang = { omega2, exceeded: omega2.gt(lim.mul(lim)) };
        }
      }
      return { mi, M, hits, ang };
    });
    return { C, lines, segIndex: i, u };
  }

  /* ---------------- 面板渲染 ---------------- */
  function renderPanels() {
    const v = els.verdict;
    const r = state.result;
    if (state.errors.length) { v.className = 'verdict invalid'; v.textContent = '配置无效，无法校核'; }
    else if (!r) { v.className = 'verdict pending'; v.textContent = '待校核'; }
    else if (r.ok) {
      v.className = 'verdict ok';
      v.textContent = hasLimits()
        ? '✓ 校核通过：全程无遮挡、跟踪角速度未超限，曝光可执行'
        : '✓ 校核通过：全程无遮挡，曝光可执行';
    } else {
      v.className = 'verdict bad';
      const occ = !!r.firstOcclusion, ang = !!r.firstAngular;
      v.textContent = occ && ang
        ? '✗ 存在遮挡且跟踪超限：该次曝光不可执行'
        : occ
          ? '✗ 存在遮挡：该次曝光不可执行'
          : '✗ 跟踪转向超限或方向失效：该次曝光不可执行';
    }

    els.errors.innerHTML = state.errors.map((e) => `<div class="err">• ${esc(e)}</div>`).join('');
    renderEvidence();
    renderReport();
    els.scrubBox.style.display = state.parsed && state.parsed.keyframes.length >= 2 ? '' : 'none';
    updateScrubLabel();
  }

  function renderEvidence() {
    const r = state.result;
    if (!r || (!r.firstOcclusion && !r.firstAngular)) { els.evidence.innerHTML = ''; return; }
    // 两张证据卡按全程最早时刻精确排序（根式与有理数的精确比较），最早者为首项依据
    const cards = [];
    if (r.firstOcclusion) cards.push({ ang: false });
    if (r.firstAngular) cards.push({ ang: true });
    if (cards.length === 2 && Geo.surdCmpRational(r.firstAngular.t, r.firstOcclusion.t) < 0) {
      cards.reverse();
    }
    els.evidence.innerHTML = cards
      .map((c, i) => (c.ang ? angularCard(r.firstAngular) : occlusionCard(r.firstOcclusion))
        .replace('<h3>', `<h3>${i === 0 ? '<span class="first-tag">首项依据</span>' : ''}`))
      .join('');
  }

  function occlusionCard(f) {
    const r = state.result;
    const seg = r.segments[f.segmentIndex];
    const M = state.parsed.markers[f.markerIndex];
    const R = state.parsed.rects[f.rectIndex];
    return `
      <div class="card danger">
        <h3>最早遮挡证据（可复核）</h3>
        <ul>
          <li>时刻：<b>t = ${esc(Geo.fmtFull(f.t))}</b>${f.tangent
            ? '（<b>相切</b>：首次擦到保护边界）'
            : `（进入遮挡区间 [${esc(fmt(f.t))}, ${esc(fmt(f.tMax))}]）`}</li>
          <li>航段：K${f.segmentIndex + 1} → K${f.segmentIndex + 2}（t ∈ [${esc(fmt(seg.t0))}, ${esc(fmt(seg.t1))}]）</li>
          <li>标记点：M${f.markerIndex + 1} ${esc(fmtP(M))}</li>
          <li>保护矩形：R${f.rectIndex + 1}　x∈[${esc(fmt(R.x1))}, ${esc(fmt(R.x2))}]，y∈[${esc(fmt(R.y1))}, ${esc(fmt(R.y2))}]</li>
          <li>相机位置：C(t) = ${esc(fmtP(f.camera))}</li>
          <li>接触点（在矩形边界上）：${esc(fmtP(f.contact))}</li>
        </ul>
        <p class="note">画布已用红色虚线绘制该时刻的相机位置、视线与接触点；拖动时间轴可逐时刻复核。</p>
      </div>`;
  }

  function angularCard(f) {
    const r = state.result;
    const seg = r.segments[f.segmentIndex];
    const M = state.parsed.markers[f.markerIndex];
    const segLine = `<li>航段：K${f.segmentIndex + 1} → K${f.segmentIndex + 2}（t ∈ [${esc(fmt(seg.t0))}, ${esc(fmt(seg.t1))}]）</li>`;
    const mkLine = `<li>标记点：M${f.markerIndex + 1} ${esc(fmtP(M))}，限值 Ω = ${esc(Geo.fmtFull(f.limit))}</li>`;
    if (f.undefined) {
      return `
      <div class="card danger">
        <h3>方向失效证据（可复核）</h3>
        <ul>
          <li>时刻：<b>t = ${esc(Geo.fmtFull(f.tStar))}</b>（相机经过标记点，激光对焦指向未定义）</li>
          ${segLine}
          ${mkLine}
          <li>相机位置：C(t) = ${esc(fmtP(f.camera))}（与标记点重合）</li>
        </ul>
        <p class="note">指向标记的方向在该时刻无定义，角速度发散；时间轴已标出该时刻。</p>
      </div>`;
    }
    return `
      <div class="card danger">
        <h3>最早跟踪超限证据（可复核）</h3>
        <ul>
          <li>超限区间：t ∈ [${esc(Geo.fmtSurd(f.t))}, ${esc(Geo.fmtSurd(f.tHi))}]
            <span class="muted">（精确端点 ${esc(Geo.fmtSurdExact(f.t))} ～ ${esc(Geo.fmtSurdExact(f.tHi))}，端点处 ω 恰等于限值）</span></li>
          ${segLine}
          ${mkLine}
          <li>最猛时刻：t = ${esc(Geo.fmtFull(f.tStar))}，相机位置 C(t) = ${esc(fmtP(f.camera))}</li>
          <li>实际角速度：<b>ω = ${esc(Geo.fmtFull(f.omegaMax))}</b> ＞ 限值 Ω = ${esc(Geo.fmtFull(f.limit))}</li>
          <li>精确比较：ω² = ${esc(Geo.fmtFull(f.omega2Max))} ＞ Ω² = ${esc(Geo.fmtFull(f.limit.mul(f.limit)))}</li>
        </ul>
        <p class="note">时间轴已用红色标出全部超限区间；画布红色虚线为最猛时刻的相机位置与视线，红色加粗航段为超限段。</p>
      </div>`;
  }

  function renderReport() {
    const r = state.result;
    if (!r) { els.report.innerHTML = '<p class="muted">完成有效配置后，此处自动给出每个航段、每条视线的安全区间。</p>'; return; }
    const iv = (s) => `${s.fromClosed ? '[' : '('}${esc(fmt(s.from))}, ${esc(fmt(s.to))}${s.toClosed ? ']' : ')'}`;
    els.report.innerHTML = r.segments.map((seg) => {
      const rows = seg.byMarker.map((bm) => {
        if (!bm.occluded.length) return `<div class="row ok">M${bm.markerIndex + 1}：全程安全</div>`;
        const occ = bm.occluded.map((o) => {
          const rs = o.rects.map((ri) => `R${ri + 1}`).join('/');
          return o.tangent
            ? `相切于 t = ${esc(fmt(o.tMin))}（${rs}）`
            : `遮挡 [${esc(fmt(o.tMin))}, ${esc(fmt(o.tMax))}]（${rs}）`;
        }).join('；');
        const safe = bm.safe.length ? bm.safe.map(iv).join(' ∪ ') : '无';
        return `<div class="row bad">M${bm.markerIndex + 1}：${occ}<br><span class="safe">安全区间：${safe}</span></div>`;
      }).join('');
      const angRows = (seg.angular || []).map((a) => {
        const mi = a.markerIndex + 1;
        if (a.undefined) {
          return `<div class="row bad">M${mi}：t = ${esc(fmt(a.tStar))} 相机经过标记点，指向未定义（限值 Ω = ${esc(fmt(a.limit))}）</div>`;
        }
        if (a.exceeded) {
          return `<div class="row bad">M${mi}：跟踪超限 ω = ${esc(Geo.fmtFull(a.omegaMax))} ＞ Ω = ${esc(fmt(a.limit))}，超限区间 t ∈ [${esc(Geo.fmtSurd(a.tLo))}, ${esc(Geo.fmtSurd(a.tHi))}]</div>`;
        }
        return `<div class="row ok">M${mi}：跟踪角速度 ω_max = ${esc(fmt(a.omegaMax))} ≤ 限值 ${esc(fmt(a.limit))}，未超限</div>`;
      }).join('');
      return `<div class="seg"><h4>航段 K${seg.index + 1} → K${seg.index + 2}（t ∈ [${esc(fmt(seg.t0))}, ${esc(fmt(seg.t1))}]）</h4>${rows}${angRows}</div>`;
    }).join('');
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
        <label>ω限 <input data-kind="marker" data-id="${m.id}" data-field="omegaStr" value="${esc(m.omegaStr || '')}" placeholder="不限" title="最大跟踪角速度（正小数，留空表示不限制）"></label>
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
      if (inp.dataset.field === 'tStr' || inp.dataset.field === 'omegaStr' || document.activeElement === inp) return;
      const it = findItem(inp.dataset.kind, Number(inp.dataset.id));
      if (it) inp.value = it[inp.dataset.field];
    });
  }

  function updateScrubLabel() {
    if (!state.parsed || state.parsed.keyframes.length < 2) { els.scrubLabel.textContent = ''; return; }
    const t = scrubT();
    const info = instantInfo(t);
    const occ = info.lines.filter((l) => l.hits.length);
    const occTxt = occ.length
      ? '　⚠ 遮挡：' + occ.map((l) => `M${l.mi + 1}×${l.hits.map((r) => 'R' + (r + 1)).join('/')}`).join('，')
      : '　✓ 此时刻全部视线安全';
    const angBad = info.lines.filter((l) => l.ang && (l.ang.exceeded || l.ang.undefined));
    const angTxt = angBad.length
      ? '　⚠ 跟踪：' + angBad.map((l) => (l.ang.undefined ? `M${l.mi + 1} 方向失效` : `M${l.mi + 1} 超限`)).join('，')
      : '';
    els.scrubLabel.textContent = `t = ${Geo.fmtFull(t)}（航段 K${info.segIndex + 1}→K${info.segIndex + 2}）` + occTxt + angTxt;
  }

  /* ---------------- 画布绘制 ---------------- */
  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawGrid();
    drawPath();
    drawAngularPaths();
    state.rects.forEach((r, i) => drawRect(r, i));
    drawAllContacts();
    drawScrubLines();
    state.markers.forEach((m, i) => drawMarker(m, i));
    state.keyframes.forEach((k, i) => drawKey(k, i));
    drawEvidence();
    drawEvidenceAngular();
    if (drag && drag.type === 'create') drawGhostRect(drag);
    drawTimeline();
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

  // 跟踪超限的航段子区间加粗标红；方向失效时刻画 ×
  function drawAngularPaths() {
    const r = state.result;
    if (!r) return;
    ctx.save();
    for (const seg of r.segments) {
      const ax = seg.A.x.toNumber(), ay = seg.A.y.toNumber();
      const bx = seg.B.x.toNumber(), by = seg.B.y.toNumber();
      const at = (u) => ({ x: ax + (bx - ax) * u, y: ay + (by - ay) * u });
      for (const a of seg.angular || []) {
        if (!a.violation) continue;
        if (a.exceeded) {
          const p1 = at(a.uLo.toNumber()), p2 = at(a.uHi.toNumber());
          ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
          ctx.strokeStyle = '#ff5a5a'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.stroke();
        } else if (a.undefined) {
          const p = at(a.uStar.toNumber());
          ctx.strokeStyle = '#ff5a5a'; ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(p.x - 7, p.y - 7); ctx.lineTo(p.x + 7, p.y + 7);
          ctx.moveTo(p.x + 7, p.y - 7); ctx.lineTo(p.x - 7, p.y + 7);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function drawScrubLines() {
    if (!state.parsed || state.parsed.keyframes.length < 2) return;
    const info = instantInfo(scrubT());
    const cx = info.C.x.toNumber(), cy = info.C.y.toNumber();
    ctx.save();
    for (const ln of info.lines) {
      const bad = ln.hits.length > 0;
      ctx.strokeStyle = bad ? '#ff5a5a' : '#3fbf6f'; ctx.lineWidth = bad ? 2 : 1.2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ln.M.x.toNumber(), ln.M.y.toNumber()); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('C(t)', cx, cy - 10);
    ctx.restore();
  }

  function drawEvidence() {
    const r = state.result;
    if (!r || !r.firstOcclusion) return;
    const f = r.firstOcclusion;
    const M = state.parsed.markers[f.markerIndex];
    const cx = f.camera.x.toNumber(), cy = f.camera.y.toNumber();
    const mx = M.x.toNumber(), my = M.y.toNumber();
    const px = f.contact.x.toNumber(), py = f.contact.y.toNumber();
    ctx.save();
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
    ctx.restore();
  }

  // 最早跟踪超限/方向失效证据：最猛时刻的相机位置与视线（红色虚线）
  function drawEvidenceAngular() {
    const r = state.result;
    if (!r || !r.firstAngular) return;
    const f = r.firstAngular;
    const M = state.parsed.markers[f.markerIndex];
    const cx = f.camera.x.toNumber(), cy = f.camera.y.toNumber();
    const mx = M.x.toNumber(), my = M.y.toNumber();
    ctx.save();
    ctx.strokeStyle = '#ff5a5a'; ctx.lineWidth = 2.5; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(mx, my); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ff8a8a'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    const label = f.undefined
      ? `方向失效 t=${fmt(f.tStar)}`
      : `跟踪超限 t=${fmt(f.tStar)}，ω=${fmt(f.omegaMax)}>Ω=${fmt(f.limit)}`;
    ctx.fillText(label, clamp(cx + 12, 4, W - 220), clamp(cy - 12, 14, H - 4));
    ctx.restore();
  }

  // 时间轴：标出全部跟踪超限区间（红色带）与方向失效时刻（竖线），白线为当前时刻
  function drawTimeline() {
    const tl = document.getElementById('timeline');
    if (!tl) return;
    const g = tl.getContext('2d');
    const wpx = tl.clientWidth, hpx = tl.height;
    if (wpx > 0 && tl.width !== wpx) tl.width = wpx;
    g.clearRect(0, 0, tl.width, hpx);
    const r = state.result;
    if (!r || !state.parsed || state.parsed.keyframes.length < 2) return;
    const t0 = r.t0.toNumber(), t1 = r.t1.toNumber();
    const X = (t) => ((t - t0) / (t1 - t0)) * tl.width;
    g.strokeStyle = '#2b333e'; g.lineWidth = 1;
    for (const k of state.parsed.keyframes) {
      const x = X(k.t.toNumber()) + 0.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, hpx); g.stroke();
    }
    g.fillStyle = 'rgba(255,90,90,0.5)';
    for (const seg of r.segments) {
      for (const a of seg.angular || []) {
        if (!a.violation) continue;
        const x1 = X(a.tLo.toNumber()), x2 = X(a.tHi.toNumber());
        if (x2 - x1 < 2) g.fillRect(x1 - 1, 0, 2, hpx); // 点事件（方向失效）
        else g.fillRect(x1, 3, x2 - x1, hpx - 6);
      }
    }
    const xc = state.scrub * tl.width;
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(xc, 0); g.lineTo(xc, hpx); g.stroke();
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
      state.markers.push({ id: uid++, x: p.x, y: p.y, omegaStr: '' });
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
      marker: '在画布上点击放置标记点（2–6 个），可在右侧补录 ω 限值',
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
      : state.result && state.result.ok
        ? (hasLimits() ? '校核通过：全程无遮挡、跟踪未超限' : '校核通过：全程无遮挡')
        : '校核完成：存在遮挡或跟踪超限，最早证据见右侧面板');
  });
  els.scrub.addEventListener('input', () => {
    state.scrub = Number(els.scrub.value) / 1000;
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
    if (d.field === 'tStr' || d.field === 'omegaStr') it[d.field] = e.target.value;
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
      { x: 480, y: 400, omegaStr: '0.5' },
      { x: 150, y: 520, omegaStr: '' },
    ].map((m) => ({ id: uid++, ...m }));
    state.rects = [
      { x: 380, y: 140, w: 200, h: 120 },
      { x: 700, y: 300, w: 120, h: 90 },
    ].map((r) => ({ id: uid++, ...r }));
    state.selected = null;
    renderLists(); recheck();
    hint('已载入示例：存在遮挡与跟踪超限，最早证据见右侧面板；可拖动元素观察实时校核');
  }

  setMode('select');
  loadSample();
})();
