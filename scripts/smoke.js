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

if (failures) {
  console.error(`\n冒烟失败：${failures} 项断言未通过`);
  process.exit(1);
}
console.log('\n冒烟通过：连续遮挡判定（含相切）与解析解完全一致');
