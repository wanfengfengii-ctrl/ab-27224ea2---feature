/*
 * geometry.js — 连续、精确的「视线段 × 保护矩形」遮挡判定（BigInt 有理数，非抽样）。
 *
 * 场景：相机在相邻关键帧之间匀速直线移动，C(u) = A + u·(B−A)，u ∈ [0,1]。
 * 对每个固定标记点 M，所有时刻的视线段 C(u)M 的并集恰好是三角形 T = △ABM，因此
 *   视线段在参数 u 处与矩形 R 相交/相切  ⟺  存在 P ∈ T∩R 落在视线段 C(u)M 上。
 * 非退化时 P 的重心坐标唯一，u(P) = β/(α+β) 是线性分式（quasilinear）函数，
 * 在凸多边形 T∩R 的顶点处取得最值 ⇒ 遮挡参数区间 = 各顶点处 u 的最小/最大值。
 * 退化（A,B,M 共线）时改用投影参数 λ 的区间覆盖论证；A==B 时退化为单条视线段。
 * 全部使用 BigInt 分数运算：相切（区间退化为单点）也能精确捕获，不做任何时刻抽样。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Geo = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ================= 精确有理数 ================= */
  function gcd(a, b) {
    a = a < 0n ? -a : a; b = b < 0n ? -b : b;
    while (b) { const t = a % b; a = b; b = t; }
    return a;
  }

  class Frac {
    constructor(num, den = 1n) {
      if (typeof num === 'number') num = BigInt(num);
      if (typeof den === 'number') den = BigInt(den);
      if (den === 0n) throw new Error('Frac: 分母为零');
      if (den < 0n) { num = -num; den = -den; }
      const g = gcd(num, den);
      this.n = num / g;
      this.d = den / g;
    }
    static of(x) { return x instanceof Frac ? x : new Frac(BigInt(x)); }
    add(o) { o = Frac.of(o); return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); }
    sub(o) { o = Frac.of(o); return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); }
    mul(o) { o = Frac.of(o); return new Frac(this.n * o.n, this.d * o.d); }
    div(o) { o = Frac.of(o); if (o.n === 0n) throw new Error('Frac: 除以零'); return new Frac(this.n * o.d, this.d * o.n); }
    neg() { return new Frac(-this.n, this.d); }
    cmp(o) { o = Frac.of(o); const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
    eq(o) { return this.cmp(o) === 0; }
    lt(o) { return this.cmp(o) < 0; }
    lte(o) { return this.cmp(o) <= 0; }
    gt(o) { return this.cmp(o) > 0; }
    gte(o) { return this.cmp(o) >= 0; }
    isZero() { return this.n === 0n; }
    toNumber() { return Number(this.n) / Number(this.d); }
    toString() { return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`; }
  }

  // 严格解析十进制字符串（如 "2"、"-0.5"、"2.75"）为精确分数；非法返回 null
  const DEC_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;
  function tryParse(s) {
    if (typeof s !== 'string') return null;
    const m = DEC_RE.exec(s.trim());
    if (!m) return null;
    const sign = m[1] === '-' ? -1n : 1n;
    const frac = m[3] || '';
    const den = 10n ** BigInt(frac.length);
    return new Frac(sign * (BigInt(m[2]) * den + (frac ? BigInt(frac) : 0n)), den);
  }

  function decimalOf(f, maxPlaces) {
    let n = f.n; const d = f.d; const neg = n < 0n;
    if (neg) n = -n;
    const ip = n / d; let rem = n % d; let digits = '';
    while (rem !== 0n && digits.length < maxPlaces) { rem *= 10n; digits += (rem / d).toString(); rem %= d; }
    return { text: (neg ? '-' : '') + ip.toString() + (digits ? '.' + digits : ''), exact: rem === 0n };
  }
  // 十进制展示：能除尽则精确，否则加省略号
  function fmt(f, maxPlaces = 9) { const p = decimalOf(f, maxPlaces); return p.exact ? p.text : p.text + '…'; }
  // 同时给出分数形式，便于复核
  function fmtFull(f) { const s = fmt(f); return f.d === 1n ? s : `${s}（= ${f.n}/${f.d}）`; }

  /* ================= 点与矩形 ================= */
  const Pt = (x, y) => ({ x: Frac.of(x), y: Frac.of(y) });
  const rectFrom = (x, y, w, h) => {
    const fx = Frac.of(x), fy = Frac.of(y);
    return { x1: fx, y1: fy, x2: fx.add(Frac.of(w)), y2: fy.add(Frac.of(h)) };
  };
  function orient(a, b, c) {
    return b.x.sub(a.x).mul(c.y.sub(a.y)).sub(b.y.sub(a.y).mul(c.x.sub(a.x)));
  }
  function pointInRectClosed(p, r) {
    return p.x.gte(r.x1) && p.x.lte(r.x2) && p.y.gte(r.y1) && p.y.lte(r.y2);
  }

  /* ============ 多边形裁剪（Sutherland–Hodgman，精确） ============ */
  function clipHalfPlane(poly, axis, bound, keepGe) {
    const val = (p) => (axis === 'x' ? p.x : p.y);
    const inside = (p) => (keepGe ? val(p).gte(bound) : val(p).lte(bound));
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = val(a).sub(bound), db = val(b).sub(bound);
      const ain = inside(a), bin = inside(b);
      if (ain) out.push(a);
      if (ain !== bin) { // 恰有一个端点在界内 ⇒ da≠db，可安全求交点
        const t = da.div(da.sub(db));
        out.push({ x: a.x.add(b.x.sub(a.x).mul(t)), y: a.y.add(b.y.sub(a.y).mul(t)) });
      }
    }
    return out;
  }
  function dedupe(poly) {
    const out = [];
    for (const p of poly) {
      const l = out[out.length - 1];
      if (!l || !l.x.eq(p.x) || !l.y.eq(p.y)) out.push(p);
    }
    if (out.length > 1) {
      const f = out[0], l = out[out.length - 1];
      if (f.x.eq(l.x) && f.y.eq(l.y)) out.pop();
    }
    return out;
  }
  function clipPolygonRect(poly, r) {
    let p = poly;
    p = clipHalfPlane(p, 'x', r.x1, true);
    p = clipHalfPlane(p, 'x', r.x2, false);
    p = clipHalfPlane(p, 'y', r.y1, true);
    p = clipHalfPlane(p, 'y', r.y2, false);
    return dedupe(p);
  }

  /* ================= 视线扫描 ================= */
  function cameraAt(A, B, u) {
    return { x: A.x.add(B.x.sub(A.x).mul(u)), y: A.y.add(B.y.sub(A.y).mul(u)) };
  }
  // 非退化三角形 ABM 中，点 P 被视线段 C(u)M 覆盖的唯一参数 u = β/(α+β) = β/(1−γ)
  function paramU(A, B, M, P) {
    const abx = B.x.sub(A.x), aby = B.y.sub(A.y);
    const amx = M.x.sub(A.x), amy = M.y.sub(A.y);
    const det = abx.mul(amy).sub(aby.mul(amx)); // (B−A)×(M−A)
    if (det.isZero()) return null;
    const apx = P.x.sub(A.x), apy = P.y.sub(A.y);
    const beta = apx.mul(amy).sub(apy.mul(amx)).div(det);  // (P−A)×(M−A)/det
    const gamma = abx.mul(apy).sub(aby.mul(apx)).div(det); // (B−A)×(P−A)/det
    const denom = new Frac(1n).sub(gamma); // = 0 仅当 P == M（调用方保证 M∉R）
    if (denom.isZero()) return null;
    return beta.div(denom);
  }

  const F0 = () => new Frac(0n), F1 = () => new Frac(1n);

  /*
   * 相机从 A 匀速移动到 B（u∈[0,1]），求视线段 C(u)M 与矩形 R 相交/相切的 u 区间。
   * 返回 null（全程安全）或 { uMin, uMax, contactMin, contactMax, ...标记 }，
   * 其中 contactMin/contactMax 是最早/最晚遮挡时视线与矩形的接触点（在矩形边界上，可复核）。
   */
  function sweepInterval(A, B, M, R) {
    if (pointInRectClosed(M, R)) { // 防御分支：配置校验本应拦截
      return { uMin: F0(), uMax: F1(), contactMin: M, contactMax: M, markerInside: true };
    }
    const poly = clipPolygonRect([A, B, M], R);
    if (!poly.length) return null;
    const abx = B.x.sub(A.x), aby = B.y.sub(A.y);
    if (abx.isZero() && aby.isZero()) { // 相机原地不动：单条视线段，要么全程遮挡要么安全
      return { uMin: F0(), uMax: F1(), contactMin: poly[0], contactMax: poly[0], stationary: true };
    }
    const det = orient(A, B, M);
    if (det.isZero()) {
      // A,B,M 共线：视线段始终在该直线上，用投影参数 λ 的区间覆盖判断。
      // 交点 λ 区间 [h1,h2] 必整体位于 m=λ(M) 的一侧（否则 M∈R，已被拦截）：
      //   h2 < m ⇒ 覆盖集 S = ⋃_{p≤h2}[0,p] = [0,h2]；h1 > m ⇒ S = [h1,1]。
      const len2 = abx.mul(abx).add(aby.mul(aby));
      const lam = (P) => P.x.sub(A.x).mul(abx).add(P.y.sub(A.y).mul(aby)).div(len2);
      const m = lam(M);
      let h1 = null, h2 = null;
      for (const V of poly) {
        const l = lam(V);
        if (h1 === null || l.lt(h1)) h1 = l;
        if (h2 === null || l.gt(h2)) h2 = l;
      }
      const at = (l) => ({ x: A.x.add(abx.mul(l)), y: A.y.add(aby.mul(l)) });
      let uMin, uMax;
      if (h2.lt(m)) { uMin = F0(); uMax = h2; } else { uMin = h1; uMax = F1(); }
      if (uMax.lt(F0()) || uMin.gt(F1())) return null;
      if (uMin.lt(F0())) uMin = F0();
      if (uMax.gt(F1())) uMax = F1();
      return { uMin, uMax, contactMin: at(h1), contactMax: at(h2), collinear: true };
    }
    // 一般情形：u(P) 是线性分式函数，最值在 T∩R 顶点处取得
    let uMin = null, uMax = null, cMin = null, cMax = null;
    for (const V of poly) {
      const u = paramU(A, B, M, V);
      if (!u) continue;
      if (uMin === null || u.lt(uMin)) { uMin = u; cMin = V; }
      if (uMax === null || u.gt(uMax)) { uMax = u; cMax = V; }
    }
    if (uMin === null) return null;
    return { uMin, uMax, contactMin: cMin, contactMax: cMax };
  }

  /* ================= 区间并集与安全补集 ================= */
  function mergeIntervals(items) { // items: [{tMin,tMax,rectIndex}]，闭区间，相邻/重叠即合并
    const sorted = items.slice().sort((a, b) => a.tMin.cmp(b.tMin) || a.tMax.cmp(b.tMax));
    const out = [];
    for (const it of sorted) {
      const last = out[out.length - 1];
      if (last && it.tMin.lte(last.tMax)) {
        if (it.tMax.gt(last.tMax)) last.tMax = it.tMax;
        last.rects.push(it.rectIndex);
      } else {
        out.push({ tMin: it.tMin, tMax: it.tMax, rects: [it.rectIndex] });
      }
    }
    for (const iv of out) iv.tangent = iv.tMin.eq(iv.tMax); // 单点区间 = 相切
    return out;
  }
  // 遮挡为闭区间 ⇒ 安全区间为开/半开区间，fromClosed/toClosed 标记端点开闭
  function safeComplement(merged, t0, t1) {
    const safe = [];
    let cur = t0, first = true;
    for (const iv of merged) {
      if (iv.tMin.gt(cur)) safe.push({ from: cur, to: iv.tMin, fromClosed: first, toClosed: false });
      if (iv.tMax.gt(cur)) cur = iv.tMax;
      first = false;
    }
    if (cur.lt(t1)) safe.push({ from: cur, to: t1, fromClosed: first, toClosed: true });
    return safe;
  }

  /* ================= 全场景校核 ================= */
  // parsed: { keyframes:[{t,p}], markers:[p], rects:[{x1,y1,x2,y2}] }（均为 Frac）
  function checkScenario(parsed) {
    const K = parsed.keyframes, Ms = parsed.markers, Rs = parsed.rects;
    const segments = [];
    let first = null;
    for (let i = 0; i < K.length - 1; i++) {
      const A = K[i].p, B = K[i + 1].p, t0 = K[i].t, t1 = K[i + 1].t;
      const span = t1.sub(t0);
      const entries = [];
      for (let mi = 0; mi < Ms.length; mi++) {
        for (let ri = 0; ri < Rs.length; ri++) {
          const sw = sweepInterval(A, B, Ms[mi], Rs[ri]);
          if (!sw) continue;
          const tMin = t0.add(sw.uMin.mul(span));
          const tMax = t0.add(sw.uMax.mul(span));
          const e = {
            markerIndex: mi, rectIndex: ri,
            uMin: sw.uMin, uMax: sw.uMax, tMin, tMax,
            contactMin: sw.contactMin, contactMax: sw.contactMax,
            tangent: sw.uMin.eq(sw.uMax),
            collinear: !!sw.collinear, stationary: !!sw.stationary, markerInside: !!sw.markerInside,
          };
          entries.push(e);
          if (!first || e.tMin.lt(first.t)) {
            first = {
              t: e.tMin, tMax: e.tMax, segmentIndex: i, markerIndex: mi, rectIndex: ri,
              u: sw.uMin, camera: cameraAt(A, B, sw.uMin), contact: sw.contactMin, tangent: e.tangent,
            };
          }
        }
      }
      const byMarker = Ms.map((_, mi) => {
        const items = entries.filter((e) => e.markerIndex === mi);
        const occluded = mergeIntervals(items);
        const safe = safeComplement(occluded, t0, t1);
        return { markerIndex: mi, occluded, safe };
      });
      segments.push({ index: i, t0, t1, A, B, entries, byMarker });
    }
    return { ok: !first, firstOcclusion: first, segments, t0: K[0].t, t1: K[K.length - 1].t };
  }

  return {
    Frac, Pt, rectFrom, tryParse, fmt, fmtFull,
    orient, pointInRectClosed, clipPolygonRect, paramU, cameraAt,
    sweepInterval, mergeIntervals, safeComplement, checkScenario,
  };
});
