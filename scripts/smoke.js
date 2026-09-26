/*
 * smoke.js — 遮挡判定冒烟测试：用有解析解的场景验证连续精确判定结果，
 * 覆盖「相交区间」「端点相切（抽样极易漏检）」「全程安全」三种情况。
 * 全部断言通过退出码 0，否则退出码 1。
 */
'use strict';
const Geo = require('../src/geometry.js');

const F = (n, d = 1) => new Geo.Frac(BigInt(n), BigInt(d));
const eqF = (f, n, d = 1) => f && f.eq(F(n, d));
const P = Geo.Pt;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ` — 实际：${extra}` : ''}`); }
}

console.log('冒烟 1：相交区间 + 端点相切（连续判定，非抽样）');
// K1(0,0)@t=0 → K2(10,0)@t=2；M1(5,10)，M2(50,−50)
// R1=[4,6]×[4,6] ⇒ 遮挡 t∈[1/2, 3/2]，首接触点 (4,6)，相机 (5/2,0)
// R2=[8,9]×[4,6] ⇒ 仅在 t=2（航段终点）与角点 (8,4) 相切：抽样时刻极易漏检
const r1 = Geo.checkScenario({
  keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }],
  markers: [P(5, 10), P(50, -50)],
  rects: [Geo.rectFrom(4, 4, 2, 2), Geo.rectFrom(8, 4, 1, 2)],
});
check('判定为不可执行', r1.ok === false);
const f = r1.firstOcclusion;
check('最早遮挡时刻 t = 1/2', eqF(f && f.t, 1, 2), f && f.t.toString());
check('涉及标记点 M1', f && f.markerIndex === 0);
check('涉及矩形 R1', f && f.rectIndex === 0);
check('相机位置 C(t) = (5/2, 0)', f && eqF(f.camera.x, 5, 2) && eqF(f.camera.y, 0));
check('接触点 = (4, 6)', f && eqF(f.contact.x, 4) && eqF(f.contact.y, 6));
const tangent = r1.segments[0].entries.find((e) => e.tangent);
check('检出端点相切条目（t = 2，R2）', !!tangent && eqF(tangent.tMin, 2) && tangent.rectIndex === 1);
check('相切接触点 = (8, 4)', tangent && eqF(tangent.contactMin.x, 8) && eqF(tangent.contactMin.y, 4));
const safe = r1.segments[0].byMarker[0].safe;
check('安全区间数量 = 2', safe.length === 2);
check('安全区间 [0, 1/2)', safe[0] && eqF(safe[0].from, 0) && eqF(safe[0].to, 1, 2) && safe[0].fromClosed && !safe[0].toClosed);
check('安全区间 (3/2, 2)', safe[1] && eqF(safe[1].from, 3, 2) && eqF(safe[1].to, 2) && !safe[1].fromClosed && !safe[1].toClosed);
check('M2 全程安全', r1.segments[0].byMarker[1].occluded.length === 0);

console.log('冒烟 2：全程安全场景');
const r2 = Geo.checkScenario({
  keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }],
  markers: [P(50, -50), P(60, -60)],
  rects: [Geo.rectFrom(4, 4, 2, 2)],
});
check('判定为可执行', r2.ok === true);
check('无最早遮挡记录', r2.firstOcclusion === null);

console.log('冒烟 3：跟踪角速度判定（连续、精确比较 ω² 与 Ω²）');
// K1(0,0)@t=0 → K2(10,0)@t=2；M1(5,1)：c = v×d0 = 10，q_min = 1（u* = 1/2）
// ω_max = 10/(2·1) = 5（有理数，精确）；限值 Ω = 2 ⇒ ω² = 25 > 4 超限
// 矩形远在 (20,20)：所有视线均未触及保护矩形，仍须判不可执行
const S0 = (a) => Geo.Surd.of(F(a));
const qOf = (u) => // q(u) = 100u² − 100u + 26（本场景），用根式运算精确回代
  Geo.surdAdd(Geo.surdAdd(Geo.surdAffine(Geo.surdMul(u, u), F(100), F(0)), Geo.surdAffine(u, F(-100), F(0))), S0(26));
const r3 = Geo.checkScenario({
  keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }],
  markers: [P(5, 1), P(50, -50)],
  rects: [Geo.rectFrom(20, 20, 2, 2)],
  limits: [F(2), null],
});
check('无遮挡但跟踪超限 ⇒ 不可执行', r3.ok === false);
check('无最早遮挡记录', r3.firstOcclusion === null);
const fa = r3.firstAngular;
check('检出最早跟踪超限', !!fa && fa.exceeded === true && fa.undefined === false);
check('超限航段为 K1→K2', fa && fa.segmentIndex === 0);
check('超限标记为 M1', fa && fa.markerIndex === 0);
check('最猛时刻 t* = 1（有理数，精确）', fa && eqF(fa.tStar, 1));
check('相机位置 C(t*) = (5, 0)', fa && eqF(fa.camera.x, 5) && eqF(fa.camera.y, 0));
check('实际角速度 ω = 5（精确有理数）', fa && eqF(fa.omegaMax, 5));
check('ω² = 25 ＞ Ω² = 4（精确平方比较）', fa && eqF(fa.omega2Max, 25) && eqF(fa.limit, 2));
const a3 = r3.segments[0].angular[0];
check('超限区间端点精确满足 q(u) = ρ = 5/2（根式回代）',
  a3 && Geo.surdCmpRational(qOf(a3.uLo), F(5, 2)) === 0 && Geo.surdCmpRational(qOf(a3.uHi), F(5, 2)) === 0);
check('超限区间中点即最猛点 u* = 1/2', a3 && Geo.surdCmp(Geo.surdAffine(a3.uLo, F(1), F(0)), a3.uHi) !== 0 &&
  Geo.surdCmpRational(a3.uLo, F(1, 2)) < 0 && Geo.surdCmpRational(a3.uHi, F(1, 2)) > 0);
check('未设限值的 M2 无角速度条目', r3.segments[0].angular.length === 1);

console.log('冒烟 4：角速度关键边界（等值不超限 / 方向失效 / 裁剪）');
// 等值边界：Ω = 5 = ω_max ⇒ 不超限（严格大于才算超限）
const r4 = Geo.checkScenario({
  keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }],
  markers: [P(5, 1), P(50, -50)],
  rects: [Geo.rectFrom(20, 20, 2, 2)],
  limits: [F(5), null],
});
check('ω_max 恰等于限值 ⇒ 不超限', r4.ok === true && r4.firstAngular === null);
// 相机经过标记：M1(5,0) 在航线上 ⇒ 方向未定义 ⇒ 不可执行（限值再大也一样）
const r5 = Geo.checkScenario({
  keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }],
  markers: [P(5, 0), P(50, -50)],
  rects: [Geo.rectFrom(20, 20, 2, 2)],
  limits: [F(100), null],
});
check('相机经过标记 ⇒ 方向失效、不可执行', r5.ok === false && r5.firstAngular && r5.firstAngular.undefined === true);
check('方向失效时刻 t = 1，相机位置 (5, 0)',
  r5.firstAngular && eqF(r5.firstAngular.tStar, 1) && eqF(r5.firstAngular.camera.x, 5) && eqF(r5.firstAngular.camera.y, 0));
// 最近点被裁剪到航段端点：M(−5,1) 在航线后方，u* 裁剪为 0，超限区间从 u = 0 开始
const r6 = Geo.checkScenario({
  keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }],
  markers: [P(-5, 1), P(50, -50)],
  rects: [Geo.rectFrom(20, 20, 2, 2)],
  limits: [F(1, 10), null],
});
const a6 = r6.segments[0].angular[0];
check('最近点裁剪到 u = 0：ω_max = 5/26', a6 && a6.exceeded && eqF(a6.omegaMax, 5, 26));
check('超限区间起点精确为 u = 0', a6 && Geo.surdCmpRational(a6.uLo, F(0)) === 0);
check('超限区间终点精确为 u = 1/5', a6 && Geo.surdCmpRational(a6.uHi, F(1, 5)) === 0);

console.log('冒烟 5：未设限值的历史标记 ⇒ 既有遮挡结论与首项证据不变');
const base = {
  keyframes: [{ t: F(0), p: P(0, 0) }, { t: F(2), p: P(10, 0) }],
  markers: [P(5, 10), P(50, -50)],
  rects: [Geo.rectFrom(4, 4, 2, 2), Geo.rectFrom(8, 4, 1, 2)],
};
const r7a = Geo.checkScenario(base);
const r7b = Geo.checkScenario({ ...base, limits: [null, null] });
let same = true;
try { require('node:assert/strict').deepEqual(r7a, r7b); } catch { same = false; }
check('有无 limits 字段（全为空）结果完全一致', same);
check('既有首项遮挡证据不变', r7b.ok === false && eqF(r7b.firstOcclusion.t, 1, 2) && r7b.firstAngular === null);

if (failures) {
  console.error(`\n冒烟失败：${failures} 项断言未通过`);
  process.exit(1);
}
console.log('\n冒烟通过：连续遮挡判定（含相切）与跟踪角速度判定（含等值边界、方向失效）均与解析解完全一致');
