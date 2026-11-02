/* ============================================================
 * calc.js · 派生计算层
 *
 * 铁律：这个文件里算出来的东西，一个都不许写回 data.js。
 * 数据文件里只有原始录入（余额、股数、成本价、现价、估值），
 * 其余全是打开页面时现算的。
 *
 * 好处：改口径不用重录历史。比如把「基金」并进「权益」，
 *      或者改集中度的分母，动这里几行，29 个月自动跟着变。
 *
 * 依赖：无。挂在 window.FIN 上，index.html 直接用。
 * ============================================================ */
(function (global) {
  "use strict";

  /* ---------- 资产类别 ----------
     顺序即环形图的绘制顺序，也是资产页的分组顺序 */
  const CLASSES = [
    { id: "cash",      name: "活期",   color: "#2f6feb", risk: "low" },
    { id: "deposit",   name: "理财",   color: "#f0a03a", risk: "low" },
    { id: "bond",      name: "债券",   color: "#8b5cf6", risk: "mid" },
    { id: "equity",    name: "权益",   color: "#e5484d", risk: "high" },
    { id: "fund",      name: "基金",   color: "#14a085", risk: "high" },
    { id: "provident", name: "公积金", color: "#64748b", risk: "locked" },
    { id: "insurance", name: "保险",   color: "#94a3b8", risk: "locked" },
    { id: "other",     name: "其他",   color: "#cbd5e1", risk: "other" },
  ];
  const CLASS_MAP = Object.fromEntries(CLASSES.map(c => [c.id, c]));
  const cls = id => CLASS_MAP[id] || { id: id || "other", name: id || "其他", color: "#cbd5e1", risk: "other" };

  // 算「权益仓位」时算作风险资产的类别
  const RISK = new Set(["equity", "fund", "bond"]);
  // 算「流动性」时算作随时能用的类别
  const LIQUID = new Set(["cash", "deposit"]);

  /* ---------- 小工具 ---------- */
  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const num = v => (v == null || v === "" || isNaN(v)) ? 0 : Number(v);
  const monthEnd = m => {
    const [y, mm] = m.split("-").map(Number);
    return new Date(Date.UTC(y, mm, 0));      // 下个月第 0 天 = 本月最后一天
  };
  const yearsBetween = (fromISO, toDate) => {
    if (!fromISO) return 0;
    const d = new Date(fromISO + (fromISO.length === 7 ? "-01" : ""));
    if (isNaN(d)) return 0;
    return Math.max(0, (toDate - d) / (365.25 * 86400000));
  };

  /* ---------- 固定资产当期净值 ----------
     规则：以「最近一次估值」为基准（没有估值就用购入价），按年折旧。
     住宅折旧率 0 → 估值一直有效；车按 15%/年自动折。 */
  function fixedValue(asset, asOfMonth) {
    const end = monthEnd(asOfMonth || asset.valued_on || asset.acquired_on || "2026-01");
    const hasVal = asset.valuation != null && asset.valuation !== "";
    const basis = hasVal ? num(asset.valuation) : num(asset.purchase_price);
    const basisOn = hasVal ? (asset.valued_on || asset.acquired_on) : asset.acquired_on;
    const rate = num(asset.dep_rate);
    const yrs = rate > 0 ? yearsBetween(basisOn, end) : 0;
    const gross = rate > 0 ? basis * Math.pow(1 - rate, yrs) : basis;
    const loan = num(asset.loan);
    return { basis, basisOn, years: yrs, gross, loan, net: gross - loan };
  }

  /* ---------- 单月完整快照（全部现算） ---------- */
  function monthData(D, month) {
    const accs = (D.accounts || []).filter(a => a.active !== false);
    const accMap = Object.fromEntries(accs.map(a => [a.id, a]));

    // ① 余额：按账户归拢，区分「现金槽位」与「汇总槽位」
    const bal = {};
    (D.balances || []).forEach(b => {
      if (b.month !== month) return;
      const k = b.account;
      if (!bal[k]) bal[k] = { cash: 0, agg: 0, rows: [] };
      if (b.agg) bal[k].agg += num(b.amount);
      else bal[k].cash += num(b.amount);
      bal[k].rows.push(b);
    });

    // ② 持仓：市值、成本、盈亏都在这里算
    const holds = [];
    const holdByAcc = {};
    (D.holdings || []).forEach(h => {
      if (h.month !== month) return;
      const qty = num(h.qty), price = num(h.price), cost = num(h.cost_price);
      const mv = r2(qty * price);
      const cv = r2(qty * cost);
      const row = Object.assign({}, h, {
        mv, cv,
        pnl: r2(mv - cv),
        pnlPct: cv > 0 ? r2((mv - cv) / cv * 100) : null,
        cls: h["class"] || "equity",
      });
      holds.push(row);
      (holdByAcc[h.account] = holdByAcc[h.account] || []).push(row);
    });
    const holdSum = id => (holdByAcc[id] || []).reduce((s, h) => s + h.mv, 0);

    // ③ 账户汇总：有明细用明细，没明细才用汇总槽位
    const byAccount = {};
    let assets = 0, liabs = 0, holdingMV = 0;
    accs.forEach(a => {
      const b = bal[a.id] || { cash: 0, agg: 0, rows: [] };
      const hs = holdSum(a.id);
      const secPart = hs > 0 ? hs : b.agg;
      const total = b.cash + secPart;
      byAccount[a.id] = {
        account: a, cash: b.cash, holdings: hs, agg: b.agg,
        usingDetail: hs > 0, total, rows: b.rows,
      };
      if (a.liability) liabs += total; else { assets += total; }
      holdingMV += hs;
    });

    // ④ 按类别聚合
    const byClass = {};
    const addCls = (id, v) => { byClass[id] = (byClass[id] || 0) + v; };
    (D.balances || []).forEach(b => {
      if (b.month !== month) return;
      const a = accMap[b.account];
      if (!a || a.liability) return;
      if (b.agg && holdSum(b.account) > 0) return;   // 有明细时汇总不再计入，避免重复
      addCls(b["class"] || a.slots?.[0]?.class || "other", num(b.amount));
    });
    holds.forEach(h => addCls(h.cls, h.mv));

    // ⑤ 固定资产
    const fixed = (D.fixed_assets || []).map(fa => Object.assign({}, fa, fixedValue(fa, month)));
    const fixedGross = fixed.reduce((s, f) => s + f.gross, 0);
    const fixedLoan = fixed.reduce((s, f) => s + f.loan, 0);

    const finNet = r2(assets - liabs);
    const totalNet = r2(finNet + fixedGross - fixedLoan);

    const riskSum = Object.entries(byClass)
      .filter(([k]) => RISK.has(k)).reduce((s, [, v]) => s + v, 0);
    const liquidSum = Object.entries(byClass)
      .filter(([k]) => LIQUID.has(k)).reduce((s, [, v]) => s + v, 0);

    // ⑥ 未拆分提示：银行账户只填了一个总数（活期/理财没分开）
    const unsplit = accs.filter(a => {
      const b = bal[a.id];
      if (!b) return false;
      const wantSlots = (a.slots || []).filter(s => s.id !== "agg").length;
      const filled = new Set(b.rows.map(r => r["class"]));
      return wantSlots > 1 && filled.size === 1;
    }).map(a => a.id);

    return {
      month, assets: r2(assets), liabs: r2(liabs), finNet, totalNet,
      fixed, fixedGross: r2(fixedGross), fixedLoan: r2(fixedLoan),
      fixedNet: r2(fixedGross - fixedLoan),
      holdingMV: r2(holdingMV),
      byClass, byAccount, holdings: holds,
      equityRatio: assets > 0 ? r2(riskSum / assets * 100) : null,
      liquidRatio: assets > 0 ? r2(liquidSum / assets * 100) : null,
      unsplit,
      hasHoldings: holds.length > 0,
    };
  }

  /* ---------- 全部月份的时间序列 ---------- */
  function series(D) {
    const months = (D.snapshots || []).map(s => s.month).sort();
    return months.map(m => {
      const d = monthData(D, m);
      return { month: m, finNet: d.finNet, totalNet: d.totalNet,
               assets: d.assets, liabs: d.liabs, fixedNet: d.fixedNet };
    });
  }

  /* ---------- 变化归因 ----------
     净资产变化 = 余额净变动 + 市价效应 + 净买入 + 固定资产变动
       · 余额净变动：账户里现金部分的变化（工资、消费、还卡之后的沉淀）
       · 市价效应  ：上期持有的股数 × 本期涨跌，纯行情
       · 净买入    ：股数变化带来的净投入（按本期价折算，无法区分分红送股）
       · 固定资产  ：估值调整、折旧、贷款变化 */
  function attribution(D, month) {
    const months = (D.snapshots || []).map(s => s.month).sort();
    const i = months.indexOf(month);
    if (i <= 0) return null;
    const prev = months[i - 1];

    const now = monthData(D, month);
    const ago = monthData(D, prev);

    // 余额净变动要含负债：信用卡多还了钱，净资产也是增加的
    const balNow = now.assets - now.holdingMV;
    const balAgo = ago.assets - ago.holdingMV;
    const dLiab = r2(now.liabs - ago.liabs);
    const dBal = r2(balNow - balAgo - dLiab);

    // 市价效应只算「两个月都有、且股数没变」的部分更保守，但会把买卖的涨跌漏掉；
    // 这里用「上期股数 × 本期涨跌」，买卖当期的涨跌归到净买入里，净买入是残差
    const prevMap = Object.fromEntries(ago.holdings.map(h => [h.code, h]));
    let market = 0;
    now.holdings.forEach(h => {
      const p = prevMap[h.code];
      if (!p) return;
      market += num(p.qty) * (num(h.price) - num(p.price));
    });
    market = r2(market);
    const dHold = r2(now.holdingMV - ago.holdingMV);
    const flow = r2(dHold - market);

    const dFixed = r2(now.fixedNet - ago.fixedNet);

    // 中间隔了几个月（有断档时，「本月变化」其实是「这几个月的变化」）
    const gap = monthsBetween(prev, month);

    return {
      prev, month, gap,
      dNet: r2(now.totalNet - ago.totalNet),
      dBal, market, flow, dFixed, dLiab,
    };
  }

  function monthsBetween(a, b) {
    const [y1, m1] = a.split("-").map(Number);
    const [y2, m2] = b.split("-").map(Number);
    return (y2 - y1) * 12 + (m2 - m1);
  }

  /* ---------- 占比与集中度 ---------- */
  function concentration(d, D) {
    const list = Object.values(d.byAccount)
      .filter(x => !x.account.liability && x.total > 0)
      .map(x => ({ name: x.account.name, owner: x.account.owner, total: x.total }))
      .sort((a, b) => b.total - a.total);
    const topAcc = list[0] || null;
    const total = d.assets || 1;

    const hs = d.holdings.slice().sort((a, b) => b.mv - a.mv);
    const topHold = hs[0] || null;

    const byOwner = {};
    Object.values(d.byAccount).forEach(x => {
      if (x.account.liability) return;
      const o = x.account.owner || "共同";
      byOwner[o] = (byOwner[o] || 0) + x.total;
    });

    return {
      topAccount: topAcc ? { name: topAcc.name, pct: r2(topAcc.total / total * 100) } : null,
      topHolding: topHold ? { name: topHold.name || topHold.code, pct: r2(topHold.mv / total * 100) } : null,
      holdingCount: hs.length,
      byOwner,
    };
  }

  /* ---------- 打开页面就能看到的异常 ---------- */
  function alerts(D, month) {
    const out = [];
    const d = monthData(D, month);
    const c = concentration(d, D);

    if (c.topAccount && c.topAccount.pct >= 40) {
      out.push({ level: "warn", text: `「${c.topAccount.name}」占金融资产 ${c.topAccount.pct}%，集中度偏高` });
    }
    if (c.topHolding && c.topHolding.pct >= 25) {
      out.push({ level: "warn", text: `单只「${c.topHolding.name}」占 ${c.topHolding.pct}%` });
    }
    if (d.unsplit.length) {
      out.push({
        level: "info",
        text: `${d.unsplit.length} 个银行账户本月未拆分活期/理财，现金占比可能失真`,
      });
    }
    (D.fixed_assets || []).forEach(fa => {
      const months = yearsBetween(fa.valued_on, monthEnd(month)) * 12;
      const since = Math.round(months);
      if (fa.valued_on && since >= 6) {
        out.push({ level: "info", text: `「${fa.name}」的估值已 ${since} 个月未更新` });
      }
    });
    // 本月没录任何数据
    if (!d.assets && !d.liabs) {
      out.push({ level: "warn", text: `${month} 还没有录入任何数据` });
    }
    return out;
  }

  global.FIN = {
    CLASSES, CLASS_MAP, cls, RISK, LIQUID,
    r2, num, monthEnd, yearsBetween, monthsBetween, fixedValue,
    monthData, series, attribution, concentration, alerts,
  };
})(window);
