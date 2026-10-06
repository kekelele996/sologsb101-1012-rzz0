# sologsb101-1012 地震台阵仪器标定与布设台账

面向地震台阵建设与运维班组的纯前端单页应用：把台站布设、仪器安装与逐次标定结果写成可追溯的台账。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22812**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22812）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3（函数组件 + Hooks） | 页面全部 `lazy` 懒加载并 `Suspense` 兜底 |
| 语言 | TypeScript 5.6（strict） | 构建脚本执行 `tsc --noEmit` 类型检查 |
| UI 组件 | Ant Design 5.22 + @ant-design/icons | 中文语言包，表格 / 表单 / Modal / 徽标 |
| 构建 | Vite 5 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Redux Toolkit 2 + react-redux 9 | `arraySlice` / `instrumentSlice` / `calibrationSlice` |
| 路由 | React Router 6（`createBrowserRouter`） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbseisarray`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/arrays` | 台阵与台站台账 | Array、Station、Instrument | 布设班组维护台站与布设日期；台网中心维护台阵状态与**投运日期**（建设中留空，转运行中必填且不早于布设）。按布设日期、运行状态与孔径分档筛选；卡片回显台站数、仪器数与标定合格率，可一键按经纬度重算孔径 |
| `/stations/:id/instruments` | 台站仪器登记与安装位置维护 | Station、Instrument | 新增/编辑/删除台站（经纬度范围校验 + 度分秒显示、基岩类型、高程），登记仪器（类型/型号/序列号**唯一性校验**/安装日期/状态）。登记后是否生成标定待办取决于所属台阵状态：建设中不进在账与周期 |
| `/calibrations` | 标定记录台 | Calibration、Instrument | 录入灵敏度、自噪与脉冲响应结论（按类型区间自动初判）、灵敏度相对上次的变化、批量改结论、灵敏度趋势折线图 |
| `/replacements` | 合格评定与更换提醒 | Replace、Calibration、Instrument | **在账口径**评定：仅「运行中且投运日期齐备」的在用/待标定仪器进在账与 365 天周期（无标定记录时周期**自投运日起算**）；超期名单与按期标定率共用同一分母（在账台数）。建设中/停测台阵的仪器单列不参评；运行中缺投运日的单列「待核」。登记更换并推进状态机（待更换→已更换→已复核） |
| `/geometry` | 台阵几何视图、两侧对账与结构版本 | 全部模型 | 实算孔径与台站间距、SVG 几何平面图与辐射距离、按台阵汇总标定结论、**布设班组 ↔ 台网中心按台站码对账**（对不上的单列、只重试本库侧、投运日不回退）、结构版本查看、全量 JSON 导入导出 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该台阵，页面渲染 `<RouteMissingPanel>` 友好空态（含「返回台阵台账」与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1012/
├── README.md
├── docker-compose.yml          # name: gbseisarray，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # Provider + ConfigProvider + RouterProvider
        ├── App.tsx             # 侧边导航 + 顶部上下文条 + 页脚，并启动各表订阅
        ├── types/              # array / station / instrument / calibration / replace / filter
        ├── stores/             # arraySlice / instrumentSlice / calibrationSlice / store.ts
        ├── components/common/  # QualifyTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCalibHistory
        ├── pages/              # ArrayList / StationInstruments / CalibrationBoard / ReplaceBoard / GeometryView
        ├── router/index.tsx    # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # geo.ts（Haversine/孔径）/ db.ts（Dexie 封装）/ reconcile.ts（两侧对账与在账周期口径）/ export.ts（导入导出与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22812
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbseisarray`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表**：`arrays`（台阵，v3 新增 `commissionDate` 投运日期）、`stations`（台站）、`instruments`（仪器）、`calibrations`（标定）、`replaces`（更换）。
- **两侧职责与升级迁移**：布设班组管台站、仪器安装位与安装日期；台网中心管台阵状态与投运日期。`db.version(1)/version(2)` 保留历史结构，`db.version(3)` 增加投运日期索引并回填：旧数据没有投运日期时，按该台阵**最早仪器安装日期**补；补不出的保持为空——台阵若已运行中则由在账口径单列为「投运日待核」，不会冒进超期名单。调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `arrays` 表为空时执行幂等播种，生成四层互相引用的演示数据（3 个台阵 / 7 个台站 / 11 台仪器 / 10 条标定 / 3 条更换），并刻意包含：1 个「建设中」台阵（仪器已安装但不进在账与周期）、1 台不合格标定（自噪超标）、2 台在账超期仪器、1 台已停用仪器、3 条不同状态的更换记录，保证每个页面打开都有内容与可演示的状态。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，`App.tsx` 挂载时启动订阅并把数据 dispatch 到 Redux slice，页面只读 selector。
- **业务规则（在账与周期口径）**：标定周期 365 天；只有台阵状态为「运行中」且投运日期齐备的在用/待标定仪器进**在账台数**与周期，建设中/停测台阵的仪器只登记不参评；有标定记录以最近标定日续算，无标定记录则周期**自投运日起算**（投运晚于安装许多也不追溯安装期）。**超期名单与按期标定率共用同一口径**（`utils/reconcile.ts` 的 `buildInstrumentLedger`，分母均为在账台数）。运行中但投运日期缺失的仪器单列为「待核」。两侧按归一化台站码（trim + 大写）对账，匹配/状态不一致/日期非法/仅本库有/仅台网中心有五类分别展示；对账失败只重试布设班组侧，台网中心核定的投运日期不回退。响应结论自动初判规则为「灵敏度落在类型区间内（宽频带 800~3000、短周期 100~800、强震 0.1~5）且自噪 ≤ 3.5」，最终以标定报告为准；仪器序列号全局唯一；更换状态机为 待更换 → 已更换 → 已复核，流转到「已更换」时把新序列号回写到仪器档案并置为在用。
- **备份与恢复**：`/geometry` 页可导出包含五张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id）」；备份时间写入 `localStorage`，页脚与几何页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
