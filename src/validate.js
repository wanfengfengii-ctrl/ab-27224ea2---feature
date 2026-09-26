/*
 * validate.js — 拍摄配置的合法性校验（数量、时间严格递增、边界、标记点/相机不得落入保护矩形）。
 * 浏览器与 Node 双端可用；校验通过时返回解析好的精确（Frac）场景供 checkScenario 使用。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./geometry.js'));
  else root.Validate = factory(root.Geo);
})(typeof self !== 'undefined' ? self : globalThis, function (Geo) {
  'use strict';

  const LIMITS = { keyframes: [2, 4], markers: [2, 6], rects: [1, 4] };

  // raw: { keyframes:[{tStr,x,y}], markers:[{x,y}], rects:[{x,y,w,h}] }；opts: {width,height}
  function scenario(raw, opts) {
    const errors = [];
    const W = opts && opts.width, H = opts && opts.height;
    const kf = raw.keyframes || [], mk = raw.markers || [], rc = raw.rects || [];

    if (kf.length < LIMITS.keyframes[0] || kf.length > LIMITS.keyframes[1])
      errors.push(`相机关键帧数量须为 ${LIMITS.keyframes[0]}–${LIMITS.keyframes[1]} 个（当前 ${kf.length} 个）`);
    if (mk.length < LIMITS.markers[0] || mk.length > LIMITS.markers[1])
      errors.push(`标记点数量须为 ${LIMITS.markers[0]}–${LIMITS.markers[1]} 个（当前 ${mk.length} 个）`);
    if (rc.length < LIMITS.rects[0] || rc.length > LIMITS.rects[1])
      errors.push(`保护矩形数量须为 ${LIMITS.rects[0]}–${LIMITS.rects[1]} 个（当前 ${rc.length} 个）`);

    const ts = [];
    kf.forEach((k, i) => {
      const t = Geo.tryParse(String(k.tStr == null ? '' : k.tStr));
      if (!t) errors.push(`关键帧 K${i + 1} 的时间「${k.tStr}」无法解析`);
      ts.push(t);
    });
    for (let i = 0; i + 1 < ts.length; i++) {
      if (ts[i] && ts[i + 1] && ts[i].cmp(ts[i + 1]) >= 0)
        errors.push(`关键帧时间须严格递增：K${i + 1}（${kf[i].tStr}）不小于 K${i + 2}（${kf[i + 1].tStr}）`);
    }

    const finite = (v) => Number.isFinite(v);
    const inBounds = (x, y) => W == null || (x >= 0 && x <= W && y >= 0 && y <= H);
    kf.forEach((k, i) => {
      if (!finite(k.x) || !finite(k.y)) errors.push(`关键帧 K${i + 1} 坐标无效`);
      else if (!inBounds(k.x, k.y)) errors.push(`关键帧 K${i + 1} 超出画布范围`);
    });
    mk.forEach((m, i) => {
      if (!finite(m.x) || !finite(m.y)) errors.push(`标记点 M${i + 1} 坐标无效`);
      else if (!inBounds(m.x, m.y)) errors.push(`标记点 M${i + 1} 超出画布范围`);
    });
    rc.forEach((r, i) => {
      if (![r.x, r.y, r.w, r.h].every(finite)) errors.push(`保护矩形 R${i + 1} 参数无效`);
      else if (!(r.w >= 4 && r.h >= 4)) errors.push(`保护矩形 R${i + 1} 的宽、高均须 ≥ 4`);
      else if (W != null && (r.x < 0 || r.y < 0 || r.x + r.w > W || r.y + r.h > H)) errors.push(`保护矩形 R${i + 1} 超出画布范围`);
    });

    if (errors.length) return { errors, parsed: null };

    const parsed = { keyframes: [], markers: [], rects: [] };
    kf.forEach((k, i) => parsed.keyframes.push({ t: ts[i], p: Geo.Pt(Math.round(k.x), Math.round(k.y)) }));
    mk.forEach((m) => parsed.markers.push(Geo.Pt(Math.round(m.x), Math.round(m.y))));
    rc.forEach((r) => parsed.rects.push(Geo.rectFrom(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h))));

    parsed.markers.forEach((M, mi) => parsed.rects.forEach((R, ri) => {
      if (Geo.pointInRectClosed(M, R)) errors.push(`标记点 M${mi + 1} 落在保护矩形 R${ri + 1} 内（或边界上），不允许`);
    }));
    parsed.keyframes.forEach((K, ki) => parsed.rects.forEach((R, ri) => {
      if (Geo.pointInRectClosed(K.p, R)) errors.push(`关键帧 K${ki + 1} 的相机位置落在保护矩形 R${ri + 1} 内（或边界上），不允许`);
    }));

    return { errors, parsed: errors.length ? null : parsed };
  }

  return { scenario, LIMITS };
});
