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
    abs() { return this.n < 0n ? new Frac(-this.n, this.d) : this; }
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

  /* ================= 二次根式（a + b·√w 的精确表示） ================= */
  // 跟踪角速度超限区间的端点是方程 q(u) = ρ 的根，一般为二次不尽根数（无理数）。
  // 用 a + b·√w（a、b、w 均为 Frac 有理数，w ≥ 0）精确表示；符号与大小比较全部
  // 只经过有限次有理数平方比较完成，不做任何浮点近似，因此「全程最早超限」的
  // 选择也是精确、稳定（确定性）的。
  class Surd {
    constructor(a, b, w) {
      this.a = Frac.of(a); this.b = Frac.of(b); this.w = Frac.of(w);
      if (this.w.cmp(F0()) < 0) throw new Error('Surd: 根号内为负');
    }
    static of(x) { return x instanceof Surd ? x : new Surd(Frac.of(x), F0(), F0()); }
    toNumber() { return this.a.toNumber() + this.b.toNumber() * Math.sqrt(this.w.toNumber()); }
    toString() { return (this.b.isZero() || this.w.isZero()) ? this.a.toString() : `${this.a} + ${this.b}·√(${this.w})`; }
  }

  const cmp0 = (f) => f.cmp(F0());
  const negSign = (s) => (s === 0 ? 0 : -s); // 避免产生 -0
  // 返回 a + b·√w 的符号（w ≥ 0）
  function signSurd1(a, b, w) {
    if (b.isZero() || w.isZero()) return cmp0(a);
    if (a.isZero()) return cmp0(b);
    const sa = cmp0(a);
    if (sa === cmp0(b)) return sa;
    // 异号：a + b·√w 的符号 = sign(a) · sign(a² − b²·w)
    const d = cmp0(a.mul(a).sub(b.mul(b).mul(w)));
    return sa > 0 ? d : negSign(d);
  }
  // 返回 b1·√w1 + b2·√w2 的符号（wi > 0，bi ≠ 0）
  function signRootSum(b1, w1, b2, w2) {
    const s1 = cmp0(b1), s2 = cmp0(b2);
    if (s1 === s2) return s1;
    const d = cmp0(b1.mul(b1).mul(w1).sub(b2.mul(b2).mul(w2)));
    return s1 > 0 ? d : negSign(d);
  }
  // 返回 a + b1·√w1 + b2·√w2 的符号（至多两个根式项，精确判定）
  function signSurd2(a, b1, w1, b2, w2) {
    const t1 = !(b1.isZero() || w1.isZero()), t2 = !(b2.isZero() || w2.isZero());
    if (!t1) return signSurd1(a, b2, w2);
    if (!t2) return signSurd1(a, b1, w1);
    if (a.isZero()) return signRootSum(b1, w1, b2, w2);
    const sRoots = signRootSum(b1, w1, b2, w2);
    const sa = cmp0(a);
    if (sRoots === 0 || sRoots === sa) return sa;
    // a 与根式和 S 异号：比较 a² 与 S² = b1²w1 + b2²w2 + 2·b1·b2·√(w1·w2)
    const bb = b1.mul(b2);
    const s2 = signSurd1(
      b1.mul(b1).mul(w1).add(b2.mul(b2).mul(w2)).sub(a.mul(a)),
      bb.add(bb),
      w1.mul(w2)
    );
    if (s2 === 0) return 0; // |S| = |a| 且异号 ⇒ 和为 0
    return s2 > 0 ? sRoots : sa;
  }

  // sign(S − r)：根式与有理数比较
  function surdCmpRational(S, r) { return signSurd1(S.a.sub(Frac.of(r)), S.b, S.w); }
  // sign(S1 − S2)：两个根式比较（精确）
  function surdCmp(S1, S2) { return signSurd2(S1.a.sub(S2.a), S1.b, S1.w, S2.b.neg(), S2.w); }

  // 同根式四则（用于端点回代复核 q(u)=ρ；根式不同且均非常数时报错）
  function sameW(S1, S2) {
    if (S1.b.isZero() || S1.w.isZero()) return S2.w;
    if (S2.b.isZero() || S2.w.isZero()) return S1.w;
    if (!S1.w.eq(S2.w)) throw new Error('Surd: 根式不同，无法合并');
    return S1.w;
  }
  function surdAdd(S1, S2) { const w = sameW(S1, S2); return new Surd(S1.a.add(S2.a), S1.b.add(S2.b), w); }
  function surdScale(S, k) { k = Frac.of(k); return new Surd(S.a.mul(k), S.b.mul(k), S.w); }
  function surdMul(S1, S2) {
    const w = sameW(S1, S2);
    return new Surd(S1.a.mul(S2.a).add(S1.b.mul(S2.b).mul(w)), S1.a.mul(S2.b).add(S1.b.mul(S2.a)), w);
  }
  // c + k·S（仿射，用于把 u 区间端点映射到 t）
  function surdAffine(S, k, c) { return surdAdd(Surd.of(c), surdScale(S, k)); }

  // 十进制展示：有理数退化为普通分数格式，否则给近似值
  function fmtSurd(S, places = 6) {
    if (S.b.isZero() || S.w.isZero()) return fmt(S.a);
    let s = S.toNumber().toFixed(places);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return `≈ ${s}`;
  }
  // 精确形式：a ± b·√w（根号内与系数用分数表示，便于复核）
  function fmtSurdExact(S) {
    if (S.b.isZero() || S.w.isZero()) return fmtFull(S.a);
    const neg = S.b.cmp(F0()) < 0;
    const bAbs = neg ? S.b.neg() : S.b;
    const coef = bAbs.eq(F1()) ? '' : `${bAbs.toString()}·`;
    return `${fmt(S.a)} ${neg ? '−' : '+'} ${coef}√(${S.w.toString()})`;
  }

  /* ================= 跟踪角速度（连续、精确） ================= */
  // 相机匀速 C(u) = A + u·(B−A)，指向标记 M 的方向向量 d(u) = (M−A) − u·(B−A)。
  // 记 v = B−A，d0 = M−A，Δt = t1−t0，则瞬时角速度大小
  //   |ω(t)| = |v × d0| / (Δt · |d(u)|²)   （分子 v×d0 沿航段为常数）
  // 故 ω²(u) = c² / (Δt² · q(u)²)，q(u) = |d(u)|² 是 u 的二次函数，
  // 最大值在最近点 u* = clamp((d0·v)/|v|², 0, 1) 处取得（有理数，非抽样）。
  // 超限 ⟺ ω²_max > Ω²（精确有理数比较）⟺ q(u) < ρ，ρ = |c|/(Ω·Δt) 为有理数；
  // 超限区间端点为 q(u) = ρ 的根 m ± √w（Surd 精确表示）。
  // q(u*) = 0 ⟺ 相机经过标记点 ⟹ 指向方向未定义，判为不可执行。
  function trackingSegment(A, B, M, t0, t1, limit) {
    const vx = B.x.sub(A.x), vy = B.y.sub(A.y);
    const dx = M.x.sub(A.x), dy = M.y.sub(A.y);
    const span = t1.sub(t0);
    const v2 = vx.mul(vx).add(vy.mul(vy));
    const res = {
      limit, exceeded: false, undefined: false, violation: false,
      uStar: null, tStar: null, cameraStar: null,
      omega2Max: null, omegaMax: null,
      uLo: null, uHi: null, tLo: null, tHi: null,
    };
    if (v2.isZero()) { // 相机静止：方向恒定（ω = 0），除非相机就停在标记上
      res.uStar = F0(); res.tStar = t0; res.cameraStar = A;
      if (dx.isZero() && dy.isZero()) {
        res.undefined = true; res.violation = true;
        res.tLo = Surd.of(t0); res.tHi = Surd.of(t1); // 整段方向未定义
      } else {
        res.omega2Max = F0(); res.omegaMax = F0();
      }
      return res;
    }
    const c = vx.mul(dy).sub(vy.mul(dx)); // v × d0（常数）
    const dot = dx.mul(vx).add(dy.mul(vy));
    let uStar = dot.div(v2);
    if (uStar.cmp(F0()) < 0) uStar = F0(); else if (uStar.cmp(F1()) > 0) uStar = F1();
    const qAt = (u) => {
      const rx = dx.sub(vx.mul(u)), ry = dy.sub(vy.mul(u));
      return rx.mul(rx).add(ry.mul(ry));
    };
    const qMin = qAt(uStar);
    res.uStar = uStar;
    res.tStar = t0.add(uStar.mul(span));
    res.cameraStar = cameraAt(A, B, uStar);
    if (qMin.isZero()) { // 相机经过标记点：指向未定义
      res.undefined = true; res.violation = true;
      res.tLo = Surd.of(res.tStar); res.tHi = Surd.of(res.tStar);
      return res;
    }
    const c2 = c.mul(c), span2 = span.mul(span);
    res.omega2Max = c2.div(qMin.mul(qMin).mul(span2));
    res.omegaMax = c.abs().div(qMin.mul(span));
    if (res.omega2Max.gt(limit.mul(limit))) { // 精确比较：ω²_max 与 Ω²
      res.exceeded = true; res.violation = true;
      const rho = c.abs().div(limit.mul(span)); // q 的临界值（有理数）
      const m = dot.div(v2); // 对称轴（有理数）
      const w = v2.mul(rho).sub(c2).div(v2.mul(v2)); // 根号内（正有理数）
      const lo = new Surd(m, new Frac(-1n), w), hi = new Surd(m, F1(), w);
      // 超限开区间 (m−√w, m+√w) 与 [0,1] 求交（端点比较有理数精确完成）
      res.uLo = surdCmpRational(lo, F0()) > 0 ? lo : Surd.of(F0());
      res.uHi = surdCmpRational(hi, F1()) < 0 ? hi : Surd.of(F1());
      res.tLo = surdAffine(res.uLo, span, t0);
      res.tHi = surdAffine(res.uHi, span, t0);
    }
    return res;
  }

  /* ================= 全场景校核 ================= */
  // parsed: { keyframes:[{t,p}], markers:[p], rects:[{x1,y1,x2,y2}], limits:[Frac|null]? }（均为 Frac）
  // limits 可选：第 i 个标记的最大跟踪角速度限值 Ω（正有理数）；缺省或为 null 表示该标记不限制，
  // 此时该标记（及全场）的遮挡结论、区间与首项证据与既有行为完全一致。
  function checkScenario(parsed) {
    const K = parsed.keyframes, Ms = parsed.markers, Rs = parsed.rects;
    const limits = parsed.limits || Ms.map(() => null);
    const segments = [];
    let first = null;
    let firstAngular = null;
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
      // —— 跟踪角速度：仅对设置了限值的标记做连续判定（不抽样）——
      const angular = [];
      for (let mi = 0; mi < Ms.length; mi++) {
        const lim = limits[mi];
        if (!lim) continue;
        const a = trackingSegment(A, B, Ms[mi], t0, t1, lim);
        a.markerIndex = mi;
        angular.push(a);
        if (a.violation && (!firstAngular || surdCmp(a.tLo, firstAngular.t) < 0)) {
          firstAngular = {
            segmentIndex: i, markerIndex: mi,
            t: a.tLo, tHi: a.tHi, tStar: a.tStar, u: a.uStar,
            camera: a.cameraStar, omegaMax: a.omegaMax, omega2Max: a.omega2Max,
            limit: lim, exceeded: a.exceeded, undefined: a.undefined,
          };
        }
      }
      segments.push({ index: i, t0, t1, A, B, entries, byMarker, angular });
    }
    return { ok: !first && !firstAngular, firstOcclusion: first, firstAngular, segments, t0: K[0].t, t1: K[K.length - 1].t };
  }

  return {
    Frac, Pt, rectFrom, tryParse, fmt, fmtFull,
    orient, pointInRectClosed, clipPolygonRect, paramU, cameraAt,
    sweepInterval, mergeIntervals, safeComplement, checkScenario,
    Surd, surdCmp, surdCmpRational, surdAdd, surdMul, surdAffine,
    fmtSurd, fmtSurdExact, trackingSegment,
  };
});
