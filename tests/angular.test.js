'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Geo = require('../src/geometry.js');

const F = (n, d = 1) => new Geo.Frac(BigInt(n), BigInt(d));
const eqF = (f, n, d = 1) => f && f.eq(F(n, d));
const P = Geo.Pt;
const Rt = (p, q, r) => new Geo.Root(F(p), q == null ? F(0) : F(q), r == null ? 0n : BigInt(r));
/* ---------------- Root：二次方程根的精确根式 ---------------- */
test('Root：完全平方自动约分为有理数', () => {
  const x = new Geo.Root(F(0), F(1), 4n); // √4 = 2
  assert.ok(x.q.isZero() && x.r === 0n && x.p.eq(F(2)));
});

test('Root：与有理数及根式的精确比较', () => {
  const x = new Geo.Root(F(0), F(5, 3), 3n); // (5/3)√3 = 5/√3 ≈ 2.887
  assert.ok(x.gt(F(2)) && x.lt(F(3)));
  assert.ok(x.eq(new Geo.Root(F(0), F(1, 3), 75n))); // (1/3)√75 = (5/3)√3
  const y = Rt(0, 1, 2); // √2
  assert.ok(x.gt(y) && y.lt(x));
  assert.ok(Rt(5, 1, 2).gt(F(6))); // 5+√2 ≈ 6.414
});

test('Root：根号内平方因子化简', () => {
  const x = new Geo.Root(F(0), F(1, 3), 75n);
  assert.equal(x.r, 3n);
  assert.ok(x.q.eq(F(5, 3)));
});

/* ---------------- angularSweep：连续角速度判定 ---------------- */
// 相机 (0,0)→(10,0)，Δt=10，v=(1,0)；标记 (5,5)
// d(τ)=(5−τ,5)，s0=−5，q=(5−τ)²+25，ω=5/q；τ=5 时 ωmax=1/5
test('angularSweep：限值恰等于端点角速度 → 整段内部超限、端点开', () => {
  const aw = Geo.angularSweep(P(0, 0), P(10, 0), F(10), P(5, 5), F(1, 10));
  assert.equal(aw.exceed.length, 1);
  const e = aw.exceed[0];
  assert.ok(eqF(e.tauLo, 0) && eqF(e.tauHi, 10));
  assert.equal(e.loClosed, false); // τ=0 时 ω=0.1≡限值，不算超限
  assert.equal(e.hiClosed, false);
  assert.ok(eqF(e.omegaMax, 1, 5), `ωmax=${e.omegaMax}`);
  assert.ok(eqF(e.maxCamera.x, 5) && eqF(e.maxCamera.y, 0));
  assert.equal(aw.undefined.length, 0);
});

test('angularSweep：限值等于峰值（判别式=0）→ 仅一点相切，不超限', () => {
  const aw = Geo.angularSweep(P(0, 0), P(10, 0), F(10), P(5, 5), F(1, 5));
  assert.equal(aw.exceed.length, 0);
  assert.equal(aw.undefined.length, 0);
});

test('angularSweep：宽松限值 → 全程合规', () => {
  const aw = Geo.angularSweep(P(0, 0), P(10, 0), F(10), P(5, 5), F(100));
  assert.equal(aw.exceed.length, 0);
});

test('angularSweep：限值更严（根严格越出航段）→ 端点闭、整段超限', () => {
  const aw = Geo.angularSweep(P(0, 0), P(10, 0), F(10), P(5, 5), F(1, 20)); // L=0.05
  const e = aw.exceed[0];
  assert.equal(e.loClosed, true);
  assert.equal(e.hiClosed, true);
  assert.ok(eqF(e.tauLo, 0) && eqF(e.tauHi, 10));
});

test('angularSweep：无理根边界的精确值（5/√3）', () => {
  // 标记 (0,5)：s0=−5，q=τ²+25；L=3/20 ⇒ θ=100/3，根 ±5/√3
  const aw = Geo.angularSweep(P(0, 0), P(10, 0), F(10), P(0, 5), F(3, 20));
  const e = aw.exceed[0];
  assert.ok(eqF(e.tauLo, 0) && e.loClosed);          // 负根严格越界 → 端点闭
  assert.equal(e.hiClosed, false);
  assert.ok(e.tauHi.eq(new Geo.Root(F(0), F(5, 3), 3n)), Geo.fmtTime(e.tauHi)); // 5/√3
  assert.ok(Math.abs(e.tauHi.approx(12) - 5 / Math.sqrt(3)) < 1e-9);
});

test('angularSweep：航线穿过标记 → 单点方向未定义，且无超限', () => {
  const aw = Geo.angularSweep(P(0, 0), P(10, 0), F(10), P(5, 0), F(1));
  assert.equal(aw.exceed.length, 0);
  assert.equal(aw.undefined.length, 1);
  assert.ok(eqF(aw.undefined[0].tau, 5));
  assert.equal(aw.undefined[0].entire, false);
});

test('angularSweep：标记恰在航段端点 → 端点方向失效', () => {
  const aw = Geo.angularSweep(P(5, 0), P(10, 0), F(10), P(5, 0), F(1));
  assert.equal(aw.undefined.length, 1);
  assert.ok(eqF(aw.undefined[0].tau, 0));
});

test('angularSweep：相机静止且与标记重合 → 整段方向未定义', () => {
  const aw = Geo.angularSweep(P(3, 3), P(3, 3), F(2), P(3, 3), F(1));
  assert.equal(aw.undefined.length, 1);
  assert.equal(aw.undefined[0].entire, true);
});

test('angularSweep：相机静止但不重合 → 角速度恒为 0', () => {
  const aw = Geo.angularSweep(P(3, 3), P(3, 3), F(2), P(9, 9), F(1));
  assert.equal(aw.exceed.length, 0);
  assert.equal(aw.undefined.length, 0);
});

/* ---------------- checkScenario 集成 ---------------- */
function scen(limits) {
  return {
    keyframes: [
      { t: F(0), p: P(60, 100) }, { t: F(4), p: P(900, 100) }, { t: F(6), p: P(900, 500) },
    ],
    markers: [P(480, 400), P(150, 520)],
    rects: [Geo.rectFrom(380, 140, 200, 120), Geo.rectFrom(700, 300, 120, 90)],
    ...(limits ? { limits } : {}),
  };
}

test('checkScenario：转向过猛即使无任何遮挡也判不可执行，首项为角速度依据', () => {
  const r = Geo.checkScenario(scen([F(3, 10), null])); // M1: ωmax=0.3
  assert.equal(r.ok, false);
  assert.equal(r.firstViolation.kind, 'angular');
  assert.equal(r.firstOcclusion, null); // 最早依据不是遮挡
  assert.equal(r.firstViolation.markerIndex, 0);
  assert.equal(r.firstViolation.segmentIndex, 0);
  // 最早时刻 = 2 − (20/21)√3 ≈ 0.3504，早于最早遮挡 48/49 ≈ 0.9796
  assert.ok(r.firstViolation.t.lt(F(48, 49)));
  assert.ok(r.firstViolation.t.eq(new Geo.Root(F(2), F(-20, 21), 3n)), Geo.fmtTime(r.firstViolation.t));
  assert.ok(eqF(r.firstViolation.omegaMax, 7, 10)); // 峰值 0.7 > 限值 0.3
});

test('checkScenario：遮挡校核与角速度校核同时生效（遮挡区间仍完整保留）', () => {
  const r = Geo.checkScenario(scen([F(3, 10), null]));
  const bm = r.segments[0].byMarker[0];
  assert.equal(bm.occluded.length, 1);
  assert.ok(eqF(bm.occluded[0].tMin, 48, 49)); // 遮挡结论不受角速度影响
  const ang = r.segments[0].angByMarker[0];
  assert.ok(ang.limit.eq(F(3, 10)));
  assert.equal(ang.exceed.length, 1);
});

test('checkScenario：未设限值的历史标记不参与角速度校核', () => {
  const r = Geo.checkScenario(scen([F(3, 10), null]));
  const a2 = r.segments[0].angByMarker[1];
  assert.equal(a2.limit, null);
  assert.equal(a2.exceed.length, 0);
  assert.equal(a2.undefined.length, 0);
});

test('checkScenario：与无限值场景相比，遮挡结论、区间、首项遮挡证据完全不变', () => {
  const old = Geo.checkScenario(scen());
  const neu = Geo.checkScenario(scen([null, null]));
  assert.equal(neu.firstOcclusion === null, false);
  const f1 = old.firstOcclusion, f2 = neu.firstOcclusion;
  assert.ok(f2.t.eq(f1.t) && f2.markerIndex === f1.markerIndex && f2.rectIndex === f1.rectIndex);
  for (let i = 0; i < old.segments.length; i++) {
    for (let mi = 0; mi < 2; mi++) {
      const a = old.segments[i].byMarker[mi].occluded;
      const b = neu.segments[i].byMarker[mi].occluded;
      assert.equal(a.length, b.length);
      a.forEach((o, k) => assert.ok(o.tMin.eq(b[k].tMin) && o.tMax.eq(b[k].tMax)));
    }
  }
});

test('checkScenario：经过标记（方向失效）成为不可执行首项依据', () => {
  const r = Geo.checkScenario({
    keyframes: [{ t: F(0), p: P(0, 10) }, { t: F(10), p: P(10, 10) }],
    markers: [P(5, 10), P(50, 50)],
    rects: [Geo.rectFrom(80, 80, 10, 10)], // 与所有视线不相交
    limits: [F(1), null],
  });
  assert.equal(r.ok, false);
  assert.equal(r.firstViolation.kind, 'undefined');
  assert.ok(eqF(r.firstViolation.t, 5));
  assert.equal(r.firstOcclusion, null);
});

test('checkScenario：无遮挡、标记不被经过、限值宽松 → 通过', () => {
  const r = Geo.checkScenario({
    keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }],
    markers: [P(50, -50), P(60, -60)],
    rects: [Geo.rectFrom(4, 4, 2, 2)],
    limits: [F(100), F(100)],
  });
  assert.equal(r.ok, true);
  assert.equal(r.firstViolation, null);
});
