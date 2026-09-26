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

  /* ================= 一次根式 p + q·√r（精确表达二次方程的根） ================= */
  function isqrt(n) { // 非负整数平方根（向下取整），Newton 迭代
    if (n < 0n) throw new Error('isqrt: 负数');
    if (n < 2n) return n;
    let x = n, y = (x + 1n) / 2n;
    while (y < x) { x = y; y = (x + n / x) / 2n; }
    return x;
  }
  function signF(f) { return f.n < 0n ? -1 : f.n > 0n ? 1 : 0; }
  // sign(p + q·√r)：异号时比较 p² 与 q²r，全程精确，无需开方
  function signPR(p, q, r) {
    if (r === 0n || q.isZero()) return signF(p);
    const sp = signF(p), sq = signF(q);
    if (sp === 0) return sq;
    if (sq === 0) return sp;
    if (sp === sq) return sp;
    const d = p.mul(p).sub(q.mul(q).mul(new Frac(r)));
    const sd = signF(d);
    if (sd === 0) return 0;
    return sd > 0 ? sp : sq; // |p| 更大则 p 主导，否则 q·√r 主导
  }
  // 小素数表（≤997），用于快速提取平方因子
  const SMALL_PRIMES = (() => {
    const n = 998, mark = new Uint8Array(n), ps = [];
    for (let i = 2; i < n; i++) if (!mark[i]) {
      ps.push(BigInt(i));
      for (let j = i * i; j < n; j += i) mark[j] = 1;
    }
    return ps;
  })();
  // 提取 n 中的平方因子：返回 { s, r } 使 n = s²·r（小素数试除 + 完全平方兜底）
  function splitSquare(n) {
    let s = 1n, r = n;
    for (const p of SMALL_PRIMES) {
      if (p * p > r) break;
      while (r % (p * p) === 0n) { r /= p * p; s *= p; }
    }
    const t = isqrt(r); // 残余恰为完全平方（如大素数平方）时兜底
    if (t * t === r) { s *= t; r = 1n; }
    return { s, r };
  }
  class Root {
    // 值 = p + q·√r（r ≥ 0；r=0 或 q=0 退化为有理数；r 为完全平方时自动约分）
    constructor(p, q, r) {
      this.p = p instanceof Frac ? p : Frac.of(p);
      this.q = q instanceof Frac ? q : Frac.of(q == null ? 0 : q);
      this.r = BigInt(r == null ? 0 : r);
      if (this.r < 0n) throw new Error('Root: 负根号');
      if (this.r > 0n && !this.q.isZero()) {
        const s = isqrt(this.r);
        if (s * s === this.r) { this.p = this.p.add(this.q.mul(new Frac(s))); this.q = F0(); this.r = 0n; }
        else if (this.r > 1n) { // 化简根号内平方因子：q·√(s²r₀) = (q·s)·√r₀
          const { s: ss, r: r0 } = splitSquare(this.r);
          if (ss > 1n) { this.q = this.q.mul(new Frac(ss)); this.r = r0; }
        }
      }
    }
    toFrac() { return this.r === 0n || this.q.isZero() ? this.p : null; }
    // 与 Frac/Root/数 精确比较（−1/0/1）：D = p₁+q₁√r₁ − p₂−q₂√r₂，异号项隔离后平方比较
    cmp(o) {
      const b = o instanceof Root ? o : new Root(Frac.of(o));
      const P = this.p.sub(b.p);
      const has1 = this.r > 0n && !this.q.isZero();
      const has2 = b.r > 0n && !b.q.isZero();
      if (!has1) return signPR(P, has2 ? b.q.neg() : F0(), has2 ? b.r : 0n);
      if (!has2) return signPR(P, this.q, this.r);
      const s1 = signPR(P, this.q, this.r); // sign(P + q₁√r₁)
      const s2 = signF(b.q.neg());           // sign(−q₂√r₂)
      if (s1 === 0) return s2;
      if (s2 === 0) return s1;
      if (s1 === s2) return s1;
      // 异号：比较 |P+q₁√r₁|² = P²+q₁²r₁+2Pq₁√r₁ 与 q₂²r₂
      const lp = P.mul(P).add(this.q.mul(this.q).mul(new Frac(this.r)));
      const r2v = b.q.mul(b.q).mul(new Frac(b.r));
      const s = signPR(lp.sub(r2v), P.mul(this.q).mul(new Frac(2n)), this.r);
      return s1 > 0 ? s : -s;
    }
    eq(o) { return this.cmp(o) === 0; }
    lt(o) { return this.cmp(o) < 0; }
    lte(o) { return this.cmp(o) <= 0; }
    gt(o) { return this.cmp(o) > 0; }
    gte(o) { return this.cmp(o) >= 0; }
    approx(digits = 12) {
      if (this.r === 0n || this.q.isZero()) return this.p.toNumber();
      const sc = 10n ** BigInt(digits);
      const s = isqrt(this.r * sc * sc);
      return this.p.toNumber() + this.q.toNumber() * (Number(s.toString()) / 10 ** digits);
    }
    toNumber() { return this.approx(15); }
    // 精确表达式文本（分数 + 根号），供证据复核
    exact() {
      if (this.r === 0n || this.q.isZero()) return this.p.toString();
      const qn = this.q.n < 0n ? this.q.neg() : this.q;
      const qs = qn.d === 1n ? qn.n.toString() : `${qn.n}/${qn.d}`;
      return `(${this.p.toString()} ${this.q.n < 0n ? '−' : '+'} ${qs}·√${this.r})`;
    }
    toString() { const f = this.toFrac(); return f ? f.toString() : `${this.approx(10)}…`; }
  }
  const asRoot = (x) => (x instanceof Root ? x : new Root(Frac.of(x)));

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

  /* ================= 跟踪角速度（连续计算，速度平方与限值平方精确比较） =================
   * 匀速段：相机 C(t)=A+v·τ，τ=t−t0∈[0,Δt]，实际时间速度 v=(B−A)/Δt（恒定）。
   * 视线向量 d(τ)=M−C(τ)，其瞬时转动角速度
   *     ω(τ) = |d(τ)×v| / |d(τ)|² = |s₀| / q(τ)，
   * 其中 s₀ = d(0)×v 在整段恒定，q(τ)=|d(τ)|² = aτ²+bτ+c ≥ 0。
   * 限值判定用平方精确比较：ω(τ) > L ⟺ q(τ) < |s₀|/L，
   * 边界 q=θ（θ=|s₀|/L）是二次方程的精确根（可能是无理数，用 Root 表达）：
   * 非抽样——超限集是解析得到的完整开区间，相切于限值（ω≡L 于一点）不算超限。
   * q(τ)=0（相机经过标记）时视线方向未定义，该时刻必须判为不可执行。
   */
  const F2 = () => new Frac(2n);
  // √f（f>0）：完全平方时返回精确 Frac，否则返回精确根式 Root
  function rootSqrtFrac(f) {
    if (f.n <= 0n) throw new Error('rootSqrtFrac: 被开方数非正');
    const v = f.n * f.d;
    const s = isqrt(v);
    if (s * s === v) return new Frac(s, f.d); // √(n/d) = s/d（v=n·d 为平方时）
    return new Root(F0(), new Frac(1n, f.d), v);
  }
  // k·x + add（x 为 Root，k/add 为 Frac）
  function rootScaleAdd(x, k, add) {
    return new Root(x.p.mul(k).add(add), x.q.mul(k), x.r);
  }
  const rootToT = (x, t0) => new Root(asRoot(x).p.add(t0), asRoot(x).q, asRoot(x).r);
  function cameraAtTau(A, vx, vy, tau) {
    const r = asRoot(tau);
    return { x: rootScaleAdd(r, vx, A.x), y: rootScaleAdd(r, vy, A.y) };
  }

  // 单航段 × 单标记的角速度校核（τ 坐标系）；L 为正的 Frac 限值。
  function angularSweep(A, B, tSpan, M, L) {
    const vx = B.x.sub(A.x).div(tSpan), vy = B.y.sub(A.y).div(tSpan);
    const mdx = M.x.sub(A.x), mdy = M.y.sub(A.y);
    const a = vx.mul(vx).add(vy.mul(vy));
    const c = mdx.mul(mdx).add(mdy.mul(mdy));
    const b = vx.mul(mdx).add(vy.mul(mdy)).mul(new Frac(-2n));
    const s0 = mdx.mul(vy).sub(mdy.mul(vx)); // d(0)×v，匀速段恒量
    const absS = s0.n < 0n ? s0.neg() : s0;
    const res = { limit: L, exceed: [], undefined: [] };

    if (a.isZero()) { // 相机静止：速度为 0；与标记重合则整段方向未定义，否则角速度恒为 0
      if (c.isZero()) res.undefined.push({ tau: F0(), entire: true, camera: M });
      return res;
    }
    // q(τ)=0 ⟺ 视线方向未定义 ⟺ 必伴随 s0=0（航线直线穿过标记），切点 τ*=−b/(2a)
    if (s0.isZero()) {
      const tStar = b.neg().div(a.mul(F2()));
      if (tStar.gte(F0()) && tStar.lte(tSpan)) res.undefined.push({ tau: tStar, entire: false, camera: M });
      return res; // θ=0：q(τ)<0 不可能，故无角速度超限
    }
    // q(τ)<θ 的判别式：aθ−s0²（>0 才有严格超限；=0 仅一点 ω≡L，不超限）
    const theta = absS.div(L);
    const disc = a.mul(theta).sub(s0.mul(s0));
    if (!disc.gt(F0())) return res;
    const sq = rootSqrtFrac(disc);
    const pc = b.neg().div(a.mul(F2()));
    // 根 = −b/(2a) ± √(判别式)/(2a) = pc ± √(aθ−s0²)/a（判别式 = 4·disc）
    const off = (sq instanceof Root) ? new Root(F0(), sq.q.div(a), sq.r) : sq.div(a);
    const rLo = off instanceof Root ? new Root(pc, off.q.neg(), off.r) : pc.sub(off);
    const rHi = off instanceof Root ? new Root(pc, off.q, off.r) : pc.add(off);
    if (rHi.lte(F0()) || rLo.gte(tSpan)) return res; // 与 (0,Δt) 内部无交（根在端点上时 ω≡L，不超限）
    // 超限集为开区间 (rLo,rHi)：根严格越出航段时端点才属于超限集；根恰在端点上时该端为开
    const loInside = rLo.gt(F0()), hiInside = rHi.lt(tSpan);
    const loClosed = !loInside && rLo.lt(F0());
    const hiClosed = !hiInside && rHi.gt(tSpan);
    const tauLo = loInside ? rLo : F0();
    const tauHi = hiInside ? rHi : tSpan;
    // 区间内 ω 上确界在 q 的顶点 τ*=−b/(2a)（Frac）取得；截出航段时钳到端点
    let tauMax = pc;
    if (tauMax.lt(F0())) tauMax = F0();
    else if (tauMax.gt(tSpan)) tauMax = tSpan;
    const qMin = a.mul(tauMax).mul(tauMax).add(b.mul(tauMax)).add(c);
    res.exceed.push({
      tauLo, tauHi, loClosed, hiClosed,
      tauMax, omegaMax: absS.div(qMin),
      maxCamera: cameraAtTau(A, vx, vy, tauMax),
    });
    return res;
  }

  // 根式/分数时刻的统一展示
  function fmtTime(x) {
    const r = asRoot(x);
    if (r.r === 0n || r.q.isZero()) return fmtFull(r.p);
    const decF = new Frac(BigInt(Math.round(r.approx(9) * 1e9)), 10n ** 9n);
    return `${fmt(decF)}…（= ${r.exact()}）`;
  }
  function fmtRootPt(p) { return `(${fmtTime(p.x)}, ${fmtTime(p.y)})`; }

  /* ================= 全场景校核 ================= */
  // parsed: { keyframes:[{t,p}], markers:[p], rects:[{x1,y1,x2,y2}], limits?:[Frac|null] }（均为 Frac）
  function checkScenario(parsed) {
    const K = parsed.keyframes, Ms = parsed.markers, Rs = parsed.rects;
    const Lims = parsed.limits || Ms.map(() => null);
    const segments = [];
    let first = null;
    // 遮挡与角速度两类证据统一按「全程最早时刻」稳定挑选；时刻相同时遮挡优先（保持既有首项）
    const tCmp = (a, b) => asRoot(a).cmp(asRoot(b));
    const consider = (rec) => {
      if (!first || tCmp(rec.t, first.t) < 0 ||
        (tCmp(rec.t, first.t) === 0 && first.kind !== 'occlusion' && rec.kind === 'occlusion')) first = rec;
    };
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
          consider({
            kind: 'occlusion', t: e.tMin, tMax: e.tMax, segmentIndex: i, markerIndex: mi, rectIndex: ri,
            u: sw.uMin, camera: cameraAt(A, B, sw.uMin), contact: sw.contactMin, tangent: e.tangent,
          });
        }
      }
      const byMarker = Ms.map((_, mi) => {
        const items = entries.filter((e) => e.markerIndex === mi);
        const occluded = mergeIntervals(items);
        const safe = safeComplement(occluded, t0, t1);
        return { markerIndex: mi, occluded, safe };
      });

      /* ---- 跟踪角速度校核：仅对设置了正限值的标记生效；未设置者保持既有结论 ---- */
      const angByMarker = Ms.map((M, mi) => {
        const L = Lims[mi];
        if (!L) return { markerIndex: mi, limit: null, exceed: [], undefined: [] };
        const aw = angularSweep(A, B, span, M, L);
        const exceed = aw.exceed.map((x) => ({
          markerIndex: mi, limit: L,
          tauLo: x.tauLo, tauHi: x.tauHi,
          tLo: rootToT(x.tauLo, t0), tHi: rootToT(x.tauHi, t0),
          loClosed: x.loClosed, hiClosed: x.hiClosed,
          tauMax: x.tauMax, tMax: t0.add(x.tauMax),
          omegaMax: x.omegaMax, maxCamera: x.maxCamera,
        }));
        const undef = aw.undefined.map((x) => ({
          markerIndex: mi,
          tau: x.tau, t: t0.add(x.tau), entire: x.entire, camera: x.camera,
        }));
        for (const ex of exceed) {
          consider({
            kind: 'angular', segmentIndex: i, markerIndex: mi, limit: L,
            t: ex.tLo, tEnd: ex.tHi, omegaAt: L, omegaMax: ex.omegaMax,
            camera: cameraAtRootT(A, B, span, ex.tauLo), peakCamera: ex.maxCamera,
            peakT: ex.tMax, loClosed: ex.loClosed, hiClosed: ex.hiClosed,
          });
        }
        for (const ud of undef) {
          consider({
            kind: 'undefined', segmentIndex: i, markerIndex: mi, t: ud.t,
            camera: ud.camera, entire: ud.entire,
          });
        }
        return { markerIndex: mi, limit: L, exceed, undefined: undef };
      });

      segments.push({ index: i, t0, t1, A, B, entries, byMarker, angByMarker });
    }
    return {
      ok: !first, firstViolation: first,
      firstOcclusion: first && first.kind === 'occlusion' ? first : null, // 向后兼容字段
      hasLimits: Lims.some((L) => L),
      segments, t0: K[0].t, t1: K[K.length - 1].t,
    };
  }

  // 相机在航段内 τ 时刻的位置（τ 可为 Root 根式时刻）
  function cameraAtRootT(A, B, span, tau) {
    const vx = B.x.sub(A.x).div(span), vy = B.y.sub(A.y).div(span);
    return cameraAtTau(A, vx, vy, tau);
  }

  return {
    Frac, Root, Pt, rectFrom, tryParse, fmt, fmtFull, fmtTime, fmtRootPt,
    orient, pointInRectClosed, clipPolygonRect, paramU, cameraAt,
    sweepInterval, mergeIntervals, safeComplement,
    angularSweep, checkScenario,
  };
});
