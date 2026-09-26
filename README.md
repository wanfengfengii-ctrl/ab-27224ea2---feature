# 水下遗址拍摄航线遮挡校核

纯前端应用：在浏览器画布上布置**相机滑轨关键帧**（2–4 个，时间严格递增）、**待拍摄标记点**（2–6 个）与**保护矩形**（1–4 个，视线不得穿过或相切），对每一段匀速直线移动中的每条「相机 → 标记点」视线做**连续、精确**的遮挡判定，给出安全区间或最早遮挡时刻及可复核证据（涉及的标记、矩形、相机位置与接触点）。

## 判定方法（为什么不是抽样）

相机在相邻关键帧间匀速直线移动：`C(u) = A + u·(B−A)`，`u ∈ [0,1]`。对固定标记点 `M`，所有时刻视线段 `C(u)M` 的并集恰好是三角形 `T = △ABM`：

- 视线在参数 `u` 处碰到矩形 `R` ⟺ 存在 `P ∈ T∩R` 落在视线段 `C(u)M` 上；
- 非退化时 `u(P) = β/(α+β)`（重心坐标之比）是线性分式函数，在凸多边形 `T∩R` 的**顶点**处取得最值，因此遮挡参数区间 = 各顶点处 `u` 的最小/最大值；
- 退化情形（`A,B,M` 共线、相机静止）有专门的精确分支；
- 全部计算使用 **BigInt 有理数**，相切（遮挡区间退化为单点）也能精确捕获——这是抽样时刻无法保证的。

输出：每个航段 × 每个标记点的遮挡闭区间（含相切时刻）与安全（开）区间，以及全场最早遮挡的时刻、航段、标记、矩形、相机位置与接触点坐标。

## 操作

- 工具栏切换模式：点击放置关键帧/标记点，拖拽画出保护矩形；选择模式下可拖动任意元素，选中矩形后拖右下角改大小；
- 右侧面板可精确录入时间 `t` 与各坐标；任何编辑都会**立即重新校核**；
- 一旦移动中首次擦到保护边界，顶部立即显示「该次曝光不可执行」，并给出首个遮挡证据卡片；画布以红色虚线绘制该时刻的相机位置、视线与接触点；
- 底部时间轴可拖动到任意精确时刻逐条复核视线（绿=安全，红=被遮挡）。

## 本地运行

无需任何依赖（Node ≥ 18 即可，仅用于测试/构建/预览）：

```bash
npm test          # 单元测试（node:test，含解析解对照）
npm run build     # 构建到 dist/
npm run smoke     # 遮挡判定冒烟（相交区间 + 端点相切 + 全程安全）
npm run verify    # 上述三步一次跑完，以退出码报告
npm run serve     # 预览 dist/（PORT 环境变量指定端口，默认 8080）
```

也可以直接用浏览器打开 `index.html`（无模块加载，file:// 可用）。

## Docker

```bash
# 启动 Web 服务（宿主机端口可配置，默认 8080）
docker compose up --build web                 # http://localhost:8080
WEB_PORT=9000 docker compose up --build web   # http://localhost:9000

# 一次性校核服务：测试 + 构建 + 遮挡判定冒烟，完成后自行退出并以退出码报告
docker compose run --rm --build verify
# 或
docker compose up --build --exit-code-from verify verify
```

- `web` 服务带健康检查（`GET /healthz`，Dockerfile 与 Compose 中均有定义）；
- `verify` 服务依次执行 `node --test`、`scripts/build.js`、`scripts/smoke.js`，任一步失败即非零退出。

## 项目结构

```
index.html            页面骨架
styles.css            样式
src/geometry.js       精确有理数 + 连续遮挡判定（浏览器/Node 双端）
src/validate.js       配置合法性校验（数量、时间递增、矩形外标记等）
src/app.js            画布交互、面板渲染、实时校核
tests/                node:test 单元测试（期望值均为手工推算的解析解）
scripts/build.js      构建：语法检查、引用校验、拷贝 dist/
scripts/smoke.js      遮挡判定冒烟（退出码报告）
scripts/verify.js     一次性校核入口（测试→构建→冒烟）
scripts/serve.js      零依赖静态服务器（含 /healthz）
Dockerfile            多阶段：verify（一次性校核）+ web（静态服务，健康检查）
docker-compose.yml    web（端口 WEB_PORT 可配）+ verify（一次性）
```
