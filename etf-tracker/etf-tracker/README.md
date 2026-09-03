# 汇金证金 ETF 持仓追踪（复刻验证版）

按《wangwang-etf.com 项目分析与最简复刻技术方案》实现的主干功能验证版。
架构与原站同构：**离线数据管道 → 静态 JSON → 纯前端渲染**，零后端、零数据库。

## 本地部署（两条命令）

```bash
python3 pipeline/run_daily.py   # 生成数据（已有产物可跳过）
python3 serve.py                # 启动 → http://localhost:8080
```

> 依赖：Python 3.9+，pandas；真实行情源需 `pip3 install akshare`（可选，见下）。
> 必须通过 http 访问（`python3 serve.py` 或 `python3 -m http.server -d site 8080`），
> 直接双击 index.html 会因浏览器 fetch file:// 限制而白屏。

## 目录结构

```
etf-tracker/
├─ pipeline/
│  ├─ sources.py          # 数据源层：东财qfq → 新浪 → demo 三级回退
│  ├─ run_daily.py        # 管道入口：采集→计算(区间统计/排名)→生成JSON
│  ├─ holdings.example.csv # 真实披露数据模板（改名为 holdings.csv 生效）
│  └─ holdings.csv        # 【你维护】汇金/证金披露数据（演示值未提供时自动生成）
├─ site/
│  ├─ index.html / styles.css / app.js   # 单页前端（原生JS + 本地ECharts）
│  ├─ vendor/echarts.min.js              # 本地化图表库，离线可用
│  └─ data/                              # 管道产物（universe/groups/etfs/{code}.json）
├─ serve.py               # 一键本地服务（含缓存策略演示）
└─ README.md
```

## 已实现的主干功能

- ETF 分组清单（46→10 只种子池，宽基 6 组 + 消费/医药），显示披露比例、演示标记
- 指标卡：最新日期 / 收盘价 / 成交额 / 份额 / 披露比例 / 披露金额
- 区间统计条：近 1 周 / 1 月 / 3 月 的价格变动、成交额、净申赎（管道预算）
- 主图：价格走势 × 披露比例双轴阶梯线 + 披露日期标记点（tooltip 显示披露金额）
- 成交额副图；份额+净申赎副图（仅有份额数据时出现，如 demo 模式）
- 时间范围按钮（1月/3月/1年/全区间）+ dataZoom 缩放拖拽，三图联动
- 组内对比表（同组 ETF：披露比例/金额、区间涨跌、成交额、净申赎）
- 夜间模式（localStorage 记忆）、移动端响应式、hash 路由（可分享 #code）

## 数据口径（重要）

| 数据 | 来源 | 说明 |
|---|---|---|
| 行情 | akshare · 东财(前复权) → 新浪(未复权) | 三级回退；新浪源未复权，分红标的需自行调整 |
| 份额 | 东财接口 best-effort | 多数仅有最新快照 → 净申赎相关功能自动隐藏 |
| **汇金/证金披露比例** | **pipeline/holdings.csv（人工维护）** | 当前为**演示值**（页面有标注）。真实值需从基金定期报告"前十大持有人"核实后填入 |

## 接入真实披露数据

1. 从巨潮资讯网/基金公司官网查定期报告"前十大持有人"中汇金、证金及关联主体合计持股；
2. 填入 `pipeline/holdings.csv`（模板见 `holdings.example.csv`）：
   `code,report_date,combined_ratio_pct,combined_value_yi`
3. 重跑 `python3 pipeline/run_daily.py` → 页面"披露为演示值"标签消失。

## 部署到 GitHub Pages（GitHub Actions 自动定时）

把"离线管道 → 静态 JSON → 静态托管"整套搬到 GitHub 生态，对应原站
**CloudBase 静态托管 + 定时调度**的部分，且**零成本、零服务器**。

### 一键部署步骤

1. 把 `etf-tracker/` 作为仓库根（含 `.github/workflows/deploy.yml`、`pipeline/`、`site/`）；
2. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**；
3. push 到 `main` 分支，或到 **Actions → 每日数据更新与部署 → Run workflow** 手动触发；
4. 几分钟后站点出现在 `https://<user>.github.io/<repo>/`。

### 工作流做了什么

| 阶段 | job | 行为 |
|---|---|---|
| 生成数据 | `build-data` | `pip install` 依赖 → `python3 pipeline/run_daily.py --mode akshare`（**仅真实源**，东财→新浪都拉不到才报错） |
| 部署 | `deploy` | `needs: build-data`，仅数据成功才上传 `site/` 到 Pages |

> **关键保护**：数据生成与部署分两个 job 且"先生成后部署"。接口偶发失败时
> 整个 run 标红，**Pages 保持上一次成功部署，绝不发布假数据**。

### 三个必须知道的约束

1. **海外 runner 访问 A 股接口不稳**。GitHub 的 `ubuntu-latest` 在美国，东财/新浪
   接口常被限流或超时。已通过"东财→新浪双源 + 失败不部署"缓解，但仍建议：
   - **生产级**：用 **self-hosted runner**（一台国内小机/云函数）跑 job，网络最稳；
   - 或接受偶发失败——反正失败不会破坏线上站。
2. **披露数据需人工维护**。真实披露无法自动抓取，`pipeline/holdings.csv` 要你
   填好 commit 进仓库；不填则页面显示"披露为演示值"。
3. **免费额度**。公开仓库 Actions 免费；私有仓库每月 2000 分钟，每日一次足够用很久。

### 想保留历史快照 / 缓存上次成功数据？

当前设计为"每次重新生成、失败不部署"。若想数据也回写仓库，可把 `build-data`
末尾改成 `git commit` 推回 `main`（注意配置 `permissions: contents: write` 并避免
触发死循环）。验证用途下无需此步。

## 与原站（wangwang-etf.com）的对照

| 模块 | 原站 | 本复刻 |
|---|---|---|
| 数据流 | 离线管道→静态JSON→CDN | 同构（本地方向）✔ |
| 前端 | 原生JS + 手绘SVG，零依赖 | 原生JS + 本地ECharts（少写 800 行绘图代码） |
| 清单/指标卡/区间统计/主图/对比表 | ✔ | ✔ |
| 份额+申赎图 | 日度份额序列 | 数据可得时展示（同 schema） |
| 融资融券/融合图/趋势分位表 | ✔ | 未实现（M4 可选） |
| 投票/反馈/AI问答/留言板 | 云函数 | 未实现（M3，验证主干无需后端） |
