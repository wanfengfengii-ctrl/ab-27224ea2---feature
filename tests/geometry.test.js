'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Geo = require('../src/geometry.js');

const F = (n, d = 1) => new Geo.Frac(BigInt(n), BigInt(d));
const eqF = (f, n, d = 1) => f.eq(F(n, d));
const P = Geo.Pt;

test('Frac：约分与四则运算', () => {
  assert.equal(F(6, 8).toString(), '3/4');
  assert.equal(F(0, 7).toString(), '0');
  assert.ok(F(1, 2).add(F(1, 3)).eq(F(5, 6)));
  assert.ok(F(2, 3).mul(F(3, 4)).eq(F(1, 2)));
  assert.ok(F(1, 2).div(F(3, 4)).eq(F(2, 3)));
  assert.ok(F(1, 2).neg().eq(F(-1, 2)));
  assert.ok(F(1, 3).lt(F(1, 2)));
  assert.ok(F(1, 2).lte(F(1, 2)) && F(1, 2).gte(F(1, 2)));
});

test('十进制解析与格式化', () => {
  assert.ok(Geo.tryParse('2.75').eq(F(11, 4)));
  assert.ok(Geo.tryParse('-0.5').eq(F(-1, 2)));
  assert.ok(Geo.tryParse('10').eq(F(10)));
  assert.ok(Geo.tryParse(' 3 ').eq(F(3)));
  assert.equal(Geo.tryParse('abc'), null);
  assert.equal(Geo.tryParse('1.2.3'), null);
  assert.equal(Geo.tryParse(''), null);
  assert.equal(Geo.fmt(F(1, 4)), '0.25');
  assert.equal(Geo.fmt(F(1, 3)), '0.333333333…');
  assert.equal(Geo.fmt(F(7)), '7');
  assert.equal(Geo.fmtFull(F(1, 2)), '0.5（= 1/2）');
});

test('orient 符号与共线', () => {
  assert.ok(Geo.orient(P(0, 0), P(1, 0), P(0, 1)).gt(F(0)));
  assert.ok(Geo.orient(P(0, 0), P(0, 1), P(1, 0)).lt(F(0)));
  assert.ok(Geo.orient(P(0, 0), P(1, 1), P(2, 2)).isZero());
});

test('三角形裁剪：矩形完全含于三角形时交集即矩形', () => {
  const poly = Geo.clipPolygonRect([P(0, 0), P(10, 0), P(5, 10)], Geo.rectFrom(4, 4, 2, 2));
  const keys = poly.map((p) => `${p.x},${p.y}`).sort();
  assert.deepEqual(keys, ['4,4', '4,6', '6,4', '6,6']);
});

test('sweep：相交区间的精确端点与接触点', () => {
  // 相机 (0,0)→(10,0)，标记 (5,10)，矩形 [4,6]×[4,6]
  // 解析解：u(x,y)=(x−y/2)/(10−y)，在 (4,6) 取最小 1/4，在 (6,6) 取最大 3/4
  const r = Geo.sweepInterval(P(0, 0), P(10, 0), P(5, 10), Geo.rectFrom(4, 4, 2, 2));
  assert.ok(eqF(r.uMin, 1, 4), `uMin=${r.uMin}`);
  assert.ok(eqF(r.uMax, 3, 4), `uMax=${r.uMax}`);
  assert.ok(eqF(r.contactMin.x, 4) && eqF(r.contactMin.y, 6));
  assert.ok(eqF(r.contactMax.x, 6) && eqF(r.contactMax.y, 6));
});

test('sweep：角点相切退化为单点区间', () => {
  // 矩形 [8,9]×[4,6] 仅角点 (8,4) 落在三角形边上 ⇒ u = 1 处相切
  const r = Geo.sweepInterval(P(0, 0), P(10, 0), P(5, 10), Geo.rectFrom(8, 4, 1, 2));
  assert.ok(eqF(r.uMin, 1) && eqF(r.uMax, 1));
  assert.ok(eqF(r.contactMin.x, 8) && eqF(r.contactMin.y, 4));
});

test('sweep：完全不相交返回 null', () => {
  assert.equal(Geo.sweepInterval(P(0, 0), P(10, 0), P(5, 10), Geo.rectFrom(20, 20, 5, 5)), null);
});

test('sweep：相机自身穿过矩形', () => {
  // 相机 (0,0)→(10,0)，标记 (5,−10)，矩形 [4,6]×[−1,1]
  // 解析解：u=(x+y/2)/(10+y)，在 (4,−1) 取 7/18，在 (6,−1) 取 11/18
  const r = Geo.sweepInterval(P(0, 0), P(10, 0), P(5, -10), Geo.rectFrom(4, -1, 2, 2));
  assert.ok(eqF(r.uMin, 7, 18), `uMin=${r.uMin}`);
  assert.ok(eqF(r.uMax, 11, 18), `uMax=${r.uMax}`);
});

test('sweep：共线退化（标记在航线延长线上）', () => {
  // 相机 (0,0)→(10,0)，标记 (18,0)，矩形 [2,4]×[−1,1]
  // 视线段覆盖 x∈[10u,18]，碰到矩形 ⟺ 10u ≤ 4 ⟺ u ≤ 2/5
  const r = Geo.sweepInterval(P(0, 0), P(10, 0), P(18, 0), Geo.rectFrom(2, -1, 2, 2));
  assert.ok(r.collinear);
  assert.ok(eqF(r.uMin, 0) && eqF(r.uMax, 2, 5), `[${r.uMin}, ${r.uMax}]`);
  assert.ok(eqF(r.contactMin.x, 2) && eqF(r.contactMax.x, 4));
});

test('sweep：相机静止（航段两端同点）', () => {
  const hit = Geo.sweepInterval(P(5, 5), P(5, 5), P(5, 10), Geo.rectFrom(4, 7, 2, 2));
  assert.ok(hit.stationary && eqF(hit.uMin, 0) && eqF(hit.uMax, 1));
  assert.equal(Geo.sweepInterval(P(0, 0), P(0, 0), P(1, 1), Geo.rectFrom(5, 5, 2, 2)), null);
});

test('sweep：标记在矩形内（防御分支，正常流程由校验拦截）', () => {
  const r = Geo.sweepInterval(P(0, 0), P(10, 0), P(5, 5), Geo.rectFrom(4, 4, 2, 2));
  assert.ok(r.markerInside && eqF(r.uMin, 0) && eqF(r.uMax, 1));
});

test('checkScenario：多航段、最早遮挡证据与安全区间', () => {
  // K1(0,0)@0 → K2(10,0)@2 → K3(10,10)@4；M1(5,10)，M2(50,−50)
  // R1=[4,6]×[4,6]：航段1 遮挡 u∈[1/4,3/4] ⇒ t∈[1/2,3/2]
  // R2=[8,9]×[4,6]：航段1 于 u=1（t=2）相切于 (8,4)；航段2 遮挡 t∈[2,3]
  const parsed = {
    keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }, { t: F(4), p: P(10, 10) }],
    markers: [P(5, 10), P(50, -50)],
    rects: [Geo.rectFrom(4, 4, 2, 2), Geo.rectFrom(8, 4, 1, 2)],
  };
  const r = Geo.checkScenario(parsed);
  assert.equal(r.ok, false);

  const f = r.firstOcclusion;
  assert.ok(eqF(f.t, 1, 2), `t=${f.t}`);
  assert.equal(f.segmentIndex, 0);
  assert.equal(f.markerIndex, 0);
  assert.equal(f.rectIndex, 0);
  assert.ok(eqF(f.camera.x, 5, 2) && eqF(f.camera.y, 0));
  assert.ok(eqF(f.contact.x, 4) && eqF(f.contact.y, 6));
  assert.equal(f.tangent, false);

  // 航段 1 / M1：遮挡 [1/2,3/2] 与相切点 t=2；安全区间 [0,1/2) ∪ (3/2,2)
  const bm = r.segments[0].byMarker[0];
  assert.equal(bm.occluded.length, 2);
  assert.ok(eqF(bm.occluded[0].tMin, 1, 2) && eqF(bm.occluded[0].tMax, 3, 2));
  assert.ok(bm.occluded[1].tangent && eqF(bm.occluded[1].tMin, 2));
  assert.equal(bm.safe.length, 2);
  assert.ok(eqF(bm.safe[0].from, 0) && eqF(bm.safe[0].to, 1, 2));
  assert.ok(bm.safe[0].fromClosed && !bm.safe[0].toClosed);
  assert.ok(eqF(bm.safe[1].from, 3, 2) && eqF(bm.safe[1].to, 2));
  assert.ok(!bm.safe[1].fromClosed && !bm.safe[1].toClosed);

  // 航段 1 / M2：全程安全
  assert.equal(r.segments[0].byMarker[1].occluded.length, 0);
  assert.equal(r.segments[0].byMarker[1].safe.length, 1);

  // 航段 2 / M1 × R2：t∈[2,3]，接触点 (8,4)→(9,6)
  const e2 = r.segments[1].entries.find((e) => e.markerIndex === 0 && e.rectIndex === 1);
  assert.ok(e2 && eqF(e2.tMin, 2) && eqF(e2.tMax, 3), e2 && `[${e2.tMin}, ${e2.tMax}]`);
  assert.ok(eqF(e2.contactMin.x, 8) && eqF(e2.contactMin.y, 4));
  assert.ok(eqF(e2.contactMax.x, 9) && eqF(e2.contactMax.y, 6));
});

test('checkScenario：全程安全', () => {
  const parsed = {
    keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }],
    markers: [P(50, -50), P(60, -60)],
    rects: [Geo.rectFrom(4, 4, 2, 2)],
  };
  const r = Geo.checkScenario(parsed);
  assert.equal(r.ok, true);
  assert.equal(r.firstOcclusion, null);
});

/* ================= 二次根式（Surd） ================= */
const S = (a, b, w) => new Geo.Surd(F(a), F(b), F(w));

test('Surd：与有理数精确比较', () => {
  assert.ok(Geo.surdCmpRational(S(3, -1, 2), F(0)) > 0); // 3 − √2 > 0
  assert.ok(Geo.surdCmpRational(S(3, -1, 2), F(2)) < 0); // 3 − √2 ≈ 1.586 < 2
  assert.ok(Geo.surdCmpRational(S(3, -1, 2), F(8, 5)) < 0); // < 1.6
  assert.ok(Geo.surdCmpRational(S(3, -1, 2), F(7, 5)) > 0); // > 1.4
  assert.equal(Geo.surdCmpRational(S(1, -1, 4), F(-1)), 0); // 1 − √4 = −1（完全平方）
  assert.equal(Geo.surdCmpRational(S(0, 0, 0), F(0)), 0);
});

test('Surd：两个根式精确比较', () => {
  assert.ok(Geo.surdCmp(S(0, 1, 2), S(0, 1, 3)) < 0); // √2 < √3
  assert.equal(Geo.surdCmp(S(0, 1, 8), S(0, 2, 2)), 0); // √8 = 2√2
  assert.ok(Geo.surdCmp(S(1, 1, 2), S(2, 1, 3)) < 0); // 1+√2 < 2+√3
  assert.ok(Geo.surdCmp(S(5, -1, 2), S(4, -1, 3)) > 0); // 5−√2 ≈ 3.59 > 4−√3 ≈ 2.27
  assert.equal(Geo.surdCmp(S(2, 1, 12), S(2, 2, 3)), 0); // 2+√12 = 2+2√3
});

test('Surd：同根式四则与仿射', () => {
  const u = S(1, -1, 2); // 1 − √2
  const u2 = Geo.surdMul(u, u); // (1−√2)² = 3 − 2√2
  assert.equal(Geo.surdCmpRational(u2, F(0)) > 0, true);
  assert.equal(Geo.surdCmp(Geo.surdAdd(u2, Geo.surdAffine(u, F(-2), F(-1))), Geo.Surd.of(F(0))), 0); // u²−2u−1 = 0
  const t = Geo.surdAffine(u, F(2), F(5)); // 5 + 2u = 7 − 2√2
  assert.equal(Geo.surdCmpRational(t, F(4)) > 0, true);
  assert.equal(Geo.surdCmpRational(t, F(5)) < 0, true);
});

/* ================= 跟踪角速度 ================= */
// 标准场景：相机 (0,0)→(10,0)，t∈[0,2]，M(5,1)
// c = v×d0 = 10，q_min = 1（u* = 1/2），ω_max = 10/(2·1) = 5
const trackBase = (limit) => Geo.trackingSegment(P(0, 0), P(10, 0), P(5, 1), F(0), F(2), limit);

test('tracking：超限的精确证据与区间端点', () => {
  const r = trackBase(F(2));
  assert.equal(r.exceeded, true);
  assert.equal(r.violation, true);
  assert.ok(eqF(r.uStar, 1, 2) && eqF(r.tStar, 1));
  assert.ok(eqF(r.cameraStar.x, 5) && eqF(r.cameraStar.y, 0));
  assert.ok(eqF(r.omegaMax, 5), `ω_max=${r.omegaMax}`);
  assert.ok(eqF(r.omega2Max, 25));
  // 区间端点为 q(u) = ρ = 5/2 的根：q(u) = 100u² − 100u + 26，根式回代精确成立
  const qOf = (u) => Geo.surdAdd(
    Geo.surdAdd(Geo.surdAffine(Geo.surdMul(u, u), F(100), F(0)), Geo.surdAffine(u, F(-100), F(0))),
    Geo.Surd.of(F(26))
  );
  assert.equal(Geo.surdCmpRational(qOf(r.uLo), F(5, 2)), 0);
  assert.equal(Geo.surdCmpRational(qOf(r.uHi), F(5, 2)), 0);
  // t 区间端点 = 2·u 端点
  assert.equal(Geo.surdCmp(Geo.surdAffine(r.uLo, F(2), F(0)), r.tLo), 0);
  assert.equal(Geo.surdCmp(Geo.surdAffine(r.uHi, F(2), F(0)), r.tHi), 0);
});

test('tracking：等值边界不超限（严格大于）', () => {
  const r = trackBase(F(5)); // ω_max = 5 = Ω
  assert.equal(r.exceeded, false);
  assert.equal(r.violation, false);
  assert.ok(eqF(r.omegaMax, 5));
  const r2 = trackBase(F(499, 100)); // 4.99 < 5 ⇒ 超限
  assert.equal(r2.exceeded, true);
});

test('tracking：未超限时只有 ω_max 记录', () => {
  const r = trackBase(F(6));
  assert.equal(r.exceeded, false);
  assert.ok(eqF(r.omegaMax, 5) && r.tLo === null);
});

test('tracking：相机经过标记 ⇒ 方向未定义', () => {
  const r = Geo.trackingSegment(P(0, 0), P(10, 0), P(5, 0), F(0), F(2), F(100));
  assert.equal(r.undefined, true);
  assert.equal(r.violation, true);
  assert.ok(eqF(r.tStar, 1) && eqF(r.cameraStar.x, 5) && eqF(r.cameraStar.y, 0));
  // 标记恰在关键帧上（端点）
  const r2 = Geo.trackingSegment(P(0, 0), P(10, 0), P(10, 0), F(0), F(2), F(1));
  assert.equal(r2.undefined, true);
  assert.ok(eqF(r2.tStar, 2));
});

test('tracking：相机静止（ω = 0 或停在标记上）', () => {
  const r = Geo.trackingSegment(P(3, 3), P(3, 3), P(3, 9), F(1), F(2), F(1, 100));
  assert.equal(r.exceeded, false);
  assert.ok(eqF(r.omegaMax, 0));
  const r2 = Geo.trackingSegment(P(3, 3), P(3, 3), P(3, 3), F(1), F(2), F(1));
  assert.equal(r2.undefined, true);
  assert.ok(eqF(r2.tStar, 1));
});

test('tracking：最近点裁剪到航段端点', () => {
  // M(−5,1) 在航线后方：u* 裁剪为 0，q_min = 26，ω_max = 10/(2·26) = 5/26
  const r = Geo.trackingSegment(P(0, 0), P(10, 0), P(-5, 1), F(0), F(2), F(1, 10));
  assert.equal(r.exceeded, true);
  assert.ok(eqF(r.uStar, 0) && eqF(r.omegaMax, 5, 26));
  assert.equal(Geo.surdCmpRational(r.uLo, F(0)), 0); // 起点被裁剪到 0
  assert.equal(Geo.surdCmpRational(r.uHi, F(1, 5)), 0); // 终点恰为 1/5（完全平方根式）
});

test('checkScenario：无遮挡但跟踪超限 ⇒ 不可执行并给出首项依据', () => {
  const r = Geo.checkScenario({
    keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }],
    markers: [P(5, 1), P(50, -50)],
    rects: [Geo.rectFrom(20, 20, 2, 2)],
    limits: [F(2), null],
  });
  assert.equal(r.ok, false);
  assert.equal(r.firstOcclusion, null);
  const f = r.firstAngular;
  assert.ok(f && f.exceeded && !f.undefined);
  assert.equal(f.segmentIndex, 0);
  assert.equal(f.markerIndex, 0);
  assert.ok(eqF(f.tStar, 1) && eqF(f.camera.x, 5) && eqF(f.camera.y, 0));
  assert.ok(eqF(f.omegaMax, 5) && eqF(f.limit, 2));
  assert.equal(r.segments[0].angular.length, 1); // M2 未设限值 ⇒ 无条目
});

test('checkScenario：全程最早超限的精确选择（跨航段、跨标记）', () => {
  // K1(0,0)@0 → K2(10,0)@2 → K3(10,10)@5
  // M1(5,1) Ω=2：航段1 tLo = 1−√(3/50) ≈ 0.755
  // M3(2,1) Ω=2：航段1 tLo = 2/5−2·√(3/200) ≈ 0.155 ← 全程最早
  // M2(9,5) Ω=3：航段2 tLo = 17/5（完全平方，有理数）
  const parsed = {
    keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }, { t: F(5), p: P(10, 10) }],
    markers: [P(5, 1), P(9, 5), P(2, 1)],
    rects: [Geo.rectFrom(30, 30, 2, 2)],
    limits: [F(2), F(3), F(2)],
  };
  const r = Geo.checkScenario(parsed);
  assert.equal(r.ok, false);
  const f = r.firstAngular;
  assert.equal(f.segmentIndex, 0);
  assert.equal(f.markerIndex, 2);
  assert.ok(eqF(f.tStar, 2, 5) && eqF(f.camera.x, 2) && eqF(f.camera.y, 0));
  // 航段 2 的超限区间端点为有理数 17/5、18/5
  const a2 = r.segments[1].angular.find((a) => a.markerIndex === 1);
  assert.ok(a2 && a2.exceeded);
  assert.equal(Geo.surdCmpRational(a2.tLo, F(17, 5)), 0);
  assert.equal(Geo.surdCmpRational(a2.tHi, F(18, 5)), 0);
  assert.ok(eqF(a2.omegaMax, 10, 3));
});

test('checkScenario：未设限值 ⇒ 遮挡结论、区间与首项证据完全不变', () => {
  const base = {
    keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }, { t: F(4), p: P(10, 10) }],
    markers: [P(5, 10), P(50, -50)],
    rects: [Geo.rectFrom(4, 4, 2, 2), Geo.rectFrom(8, 4, 1, 2)],
  };
  const r0 = Geo.checkScenario(base);
  const r1 = Geo.checkScenario({ ...base, limits: [null, null] });
  assert.deepEqual(r1, r0);
  assert.equal(r1.firstAngular, null);
  assert.equal(r1.ok, false);
  assert.ok(eqF(r1.firstOcclusion.t, 1, 2));
});

test('checkScenario：遮挡与超限并存 ⇒ 两项首项证据都在', () => {
  const r = Geo.checkScenario({
    keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }],
    markers: [P(5, 10), P(5, 1)],
    rects: [Geo.rectFrom(4, 4, 2, 2)],
    limits: [null, F(2)],
  });
  assert.equal(r.ok, false);
  assert.ok(r.firstOcclusion && eqF(r.firstOcclusion.t, 1, 2));
  assert.ok(r.firstAngular && r.firstAngular.markerIndex === 1);
});

test('fmtSurd / fmtSurdExact 展示', () => {
  assert.equal(Geo.fmtSurd(Geo.Surd.of(F(3, 2))), '1.5');
  assert.match(Geo.fmtSurd(S(1, -1, 2)), /^≈ -0\.414214/);
  assert.equal(Geo.fmtSurdExact(S(1, -1, 2)), '1 − √(2)');
  assert.equal(Geo.fmtSurdExact(Geo.Surd.of(F(7))), '7');
});
