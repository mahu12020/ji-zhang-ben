/* ==========================================================================
   记账本 · 应用逻辑
   - 两位使用方：马（每月 1 号为账期起点）、胡（每月 15 号为账期起点）
   - 账期内记录支出：金额 + 用途（个人 / 家庭 / 麦麦）
   - 每次记账后给出「至本账期结束的日均可用花费」
   - 数据以 GitHub 仓库 ledger.json 为云端主副本，浏览器 localStorage 作本地缓存
   - 本地改动自动 commit 回仓库；打开页面 / 点刷新时从仓库拉取合并
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. 存储说明
   *    GitHub Pages 版：无后端，数据保存在浏览器 localStorage。
   *    手机 / 电脑各存一份，跨设备同步用页脚的「导出 / 导入」。
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * 2. 业务常量
   * ------------------------------------------------------------------ */
  var MEMBERS = [
    { key: 'ma', name: '马', anchorDay: 1, accent: '#3B9BF7', accentDeep: '#1E72CC', soft: '#E7F2FF' },
    { key: 'hu', name: '胡', anchorDay: 15, accent: '#FF6FA5', accentDeep: '#DB4A83', soft: '#FFEDF5' }
  ];
  var MEMBER_MAP = {};
  MEMBERS.forEach(function (m) { MEMBER_MAP[m.key] = m; });

  var PURPOSES = [
    { key: 'personal', name: '个人', color: '#3B9BF7' },
    { key: 'family', name: '家庭', color: '#2BC49A' },
    { key: 'maimai', name: '麦麦', color: '#FFA32B' }
  ];
  var PURPOSE_MAP = {};
  PURPOSES.forEach(function (p) { PURPOSE_MAP[p.key] = p; });

  /* 记录类型：支出（默认）/ 收入 */
  var KIND_EXPENSE = 'expense';
  var KIND_INCOME = 'income';
  var INCOME_COLOR = '#12A594';                 // 收入色（青绿），与「家庭」薄荷绿区分
  var INCOME_PURPOSE = 'income';                // 收入记录在 purpose 字段中的占位值

  function isIncomeRow(r) { return !!r && r.kind === KIND_INCOME; }

  var ROLE_ALL = 'all';

  /* ------------------------------------------------------------------ *
   * 3. 通用工具
   * ------------------------------------------------------------------ */
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  function parseYmd(s) {
    var p = String(s).slice(0, 10).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function dayIndex(d) {
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  }

  /** 两个日期之间相差的整天数（b - a） */
  function daysBetween(aIso, bIso) {
    return dayIndex(parseYmd(bIso)) - dayIndex(parseYmd(aIso));
  }

  function todayIso() { return ymd(new Date()); }

  function fmtDate(iso) {
    var d = parseYmd(iso);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function fmtDateFull(iso) {
    var d = parseYmd(iso);
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /** 按天分组表头用的日期标签：今天 / 昨天 / 具体日期（跨年时带年份） */
  function fmtDayHeading(iso, todayIsoStr) {
    if (iso === todayIsoStr) return '今天 · ' + fmtDate(iso);
    var y = parseYmd(iso).getFullYear();
    if (y === parseYmd(todayIsoStr).getFullYear()) return fmtDate(iso);
    return y + '年' + fmtDate(iso);
  }

  /** 同一天的记录归入一组，保持传入顺序（外部已按日期倒序、同日按 id 倒序排好） */
  function groupRowsByDay(rows) {
    var out = [];
    var map = {};
    rows.forEach(function (r) {
      var k = r.spent_on;
      if (!map[k]) { map[k] = { date: k, rows: [] }; out.push(map[k]); }
      map[k].rows.push(r);
    });
    return out;
  }

  /** 某一天的合计金额 */
  function dayTotal(rows) {
    return rows.reduce(function (s, r) { return s + (Number(r.amount) || 0); }, 0);
  }

  /** 按天分组渲染记录行，返回 HTML 片段 */
  function dayGroupedRowsHtml(rows, opts) {
    opts = opts || {};
    return groupRowsByDay(rows).map(function (g) {
      var head = '<div class="day-head">' +
        '<span class="d-title">' + esc(fmtDayHeading(g.date, todayIso())) + '</span>' +
        '<span class="d-meta">' + g.rows.length + ' 笔 · ' + money(dayTotal(g.rows)) + '</span>' +
      '</div>';
      return head + g.rows.map(function (r) { return recordRowHtml(r, opts); }).join('');
    }).join('');
  }

  function money(n) {
    var v = Number(n) || 0;
    var neg = v < 0;
    var s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-¥' : '¥') + s;
  }

  /** 紧凑金额（无千分位）：用于总览小卡片等宽度受限处；≥1 万去掉小数，保证单行不溢出 */
  function moneyShort(n) {
    var v = Number(n) || 0;
    var neg = v < 0;
    var a = Math.abs(v);
    return (neg ? '-¥' : '¥') + (a >= 10000 ? String(Math.round(a)) : a.toFixed(2));
  }

  function num2(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(id) { return document.getElementById(id); }

  /**
   * 计算某个成员在某天所属的账期。
   * anchorDay = 1  → 当月 1 日 ~ 当月最后一日
   * anchorDay = 15 → 当月 15 日 ~ 次月 14 日
   */
  function cycleFor(anchorDay, dateIso) {
    var d = parseYmd(dateIso);
    var y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
    var start = day >= anchorDay ? new Date(y, m, anchorDay) : new Date(y, m - 1, anchorDay);
    var next = new Date(start.getFullYear(), start.getMonth() + 1, anchorDay);
    var end = new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1);
    return { start: ymd(start), end: ymd(end) };
  }

  /** 账期展示文案：如「10月1日 — 10月31日」 */
  function cycleLabel(cyc) { return fmtDate(cyc.start) + ' — ' + fmtDate(cyc.end); }

  /** 账期归属文案：马 → 2026年10月；胡 → 2026.09.15 期 */
  /** 账期标题：马 / 胡 统一为「YYYY年M月」（完整起止日期由 cycleLabel 展示） */
  function cycleTitle(member, cyc) {
    var s = parseYmd(cyc.start);
    return s.getFullYear() + '年' + (s.getMonth() + 1) + '月';
  }

  /* ------------------------------------------------------------------ *
   * 4. 应用状态
   * ------------------------------------------------------------------ */
  var state = {
    role: 'ma',
    cycles: [],
    records: [],
    loading: true,
    error: null,
    rangeMode: 'current',   // current | history
    chartYear: null,        // 总览「按周期支出」柱状图当前查看的年份
    lastSync: null
  };

    /* ------------------------------------------------------------------ *
   * 5. 数据层：GitHub 仓库同步 + localStorage 本地缓存
   *    - 云端主副本：仓库内 ledger.json（每次改动自动 commit）
   *    - 本地缓存：浏览器 localStorage，断网时仍可记账，恢复后自动补传
   * ------------------------------------------------------------------ */
  var STORE_KEY = 'ledger_data_v1';

  /* GitHub 同步配置。
     写入凭据（fine-grained token）不放进代码：公开仓库的代码人人可见，
     首次写入时提示输入一次，只保存在当前设备浏览器的 localStorage。
     读取是公开接口，不需要密钥。 */
  var GH_TOKEN_KEY = 'ledger_gh_token';
  var GH = {
    owner: 'mahu12020',
    repo: 'ji-zhang-ben',
    branch: 'main',
    file: 'ledger.json'
  };

  function ghGetToken() {
    try { return (localStorage.getItem(GH_TOKEN_KEY) || '').trim(); } catch (e) { return ''; }
  }

  function ghSetToken(t) {
    try { localStorage.setItem(GH_TOKEN_KEY, String(t || '').trim()); } catch (e) { /* 忽略 */ }
  }

  var SEED = {"ledger_cycles":[{"id":1,"owner":"hu","start_date":"2026-09-15","end_date":"2026-10-14","initial_amount":2435.79,"created_at":"2026-10-09T13:47:06.999112+08:00","updated_at":"2026-10-09T13:47:06.999112+08:00"},{"id":3,"owner":"hu","start_date":"2026-10-15","end_date":"2026-11-14","initial_amount":2258.89,"created_at":"2026-10-15T16:06:23.942431+08:00","updated_at":"2026-10-15T16:06:23.942431+08:00"},{"id":4,"owner":"ma","start_date":"2026-11-01","end_date":"2026-11-30","initial_amount":2500.0,"created_at":"2026-11-01T18:18:51.07865+08:00","updated_at":"2026-11-01T18:18:51.07865+08:00"}],"ledger_records":[{"id":1,"owner":"hu","amount":9.0,"purpose":"personal","spent_on":"2026-09-16","note":"罗森早饭","created_at":"2026-10-09T13:47:39.52045+08:00","kind":"expense"},{"id":2,"owner":"hu","amount":38.0,"purpose":"family","spent_on":"2026-09-16","note":"墨鱼丸","created_at":"2026-10-09T13:48:22.092152+08:00","kind":"expense"},{"id":3,"owner":"hu","amount":19.8,"purpose":"personal","spent_on":"2026-09-16","note":"花盆","created_at":"2026-10-09T13:48:36.471608+08:00","kind":"expense"},{"id":4,"owner":"hu","amount":178.0,"purpose":"personal","spent_on":"2026-09-16","note":"爱奇艺续费","created_at":"2026-10-09T13:49:13.126014+08:00","kind":"expense"},{"id":5,"owner":"hu","amount":428.74,"purpose":"maimai","spent_on":"2026-09-16","note":"麦麦衣服","created_at":"2026-10-09T13:49:41.490581+08:00","kind":"expense"},{"id":6,"owner":"hu","amount":99.0,"purpose":"maimai","spent_on":"2026-09-16","note":"碎碎面、小米","created_at":"2026-10-09T13:50:42.123788+08:00","kind":"expense"},{"id":7,"owner":"hu","amount":24.91,"purpose":"maimai","spent_on":"2026-09-16","note":"玉米淀粉","created_at":"2026-10-09T13:51:08.204142+08:00","kind":"expense"},{"id":8,"owner":"hu","amount":14.9,"purpose":"personal","spent_on":"2026-09-16","note":"多肉土","created_at":"2026-10-09T13:51:26.437022+08:00","kind":"expense"},{"id":9,"owner":"hu","amount":9.9,"purpose":"personal","spent_on":"2026-09-17","note":"罗森早饭","created_at":"2026-10-09T13:52:33.037735+08:00","kind":"expense"},{"id":10,"owner":"hu","amount":27.0,"purpose":"family","spent_on":"2026-09-17","note":"CoCo","created_at":"2026-10-09T13:52:48.873016+08:00","kind":"expense"},{"id":11,"owner":"hu","amount":48.6,"purpose":"family","spent_on":"2026-09-17","note":"肯德基晚饭","created_at":"2026-10-09T13:53:06.753901+08:00","kind":"expense"},{"id":12,"owner":"hu","amount":6.0,"purpose":"maimai","spent_on":"2026-09-18","note":"儿保","created_at":"2026-10-09T13:53:48.214582+08:00","kind":"expense"},{"id":13,"owner":"hu","amount":68.0,"purpose":"family","spent_on":"2026-09-18","note":"血橙","created_at":"2026-10-09T13:54:07.312688+08:00","kind":"expense"},{"id":14,"owner":"hu","amount":28.0,"purpose":"maimai","spent_on":"2026-09-18","note":"一周岁相框","created_at":"2026-10-09T13:54:28.747487+08:00","kind":"expense"},{"id":15,"owner":"hu","amount":29.8,"purpose":"personal","spent_on":"2026-09-18","note":"罗森牛奶卡","created_at":"2026-10-09T13:54:47.628388+08:00","kind":"expense"},{"id":19,"owner":"hu","amount":60.0,"purpose":"personal","spent_on":"2026-09-19","note":"𰻝𰻝面","created_at":"2026-10-09T16:54:34.727724+08:00","kind":"expense"},{"id":20,"owner":"hu","amount":11.4,"purpose":"personal","spent_on":"2026-09-20","note":"罗森早饭","created_at":"2026-10-09T16:55:04.842221+08:00","kind":"expense"},{"id":21,"owner":"hu","amount":10.0,"purpose":"personal","spent_on":"2026-09-21","note":"电瓶车补胎","created_at":"2026-10-09T16:55:40.897862+08:00","kind":"expense"},{"id":22,"owner":"hu","amount":5.5,"purpose":"personal","spent_on":"2026-09-21","note":"罗森早饭","created_at":"2026-10-09T16:56:05.131858+08:00","kind":"expense"},{"id":23,"owner":"hu","amount":186.0,"purpose":"personal","spent_on":"2026-09-22","note":"宣传资料","created_at":"2026-10-09T16:57:00.766153+08:00","kind":"expense"},{"id":24,"owner":"hu","amount":13.88,"purpose":"personal","spent_on":"2026-10-10","note":"罗森早饭","created_at":"2026-10-10T08:35:01.564048+08:00","kind":"expense"},{"id":25,"owner":"hu","amount":0.12,"purpose":"income","spent_on":"2026-09-21","note":"利息","created_at":"2026-10-10T13:01:20.325063+08:00","kind":"income"},{"id":26,"owner":"hu","amount":16.9,"purpose":"personal","spent_on":"2026-09-22","note":"DQ","created_at":"2026-10-10T13:02:05.8711+08:00","kind":"expense"},{"id":27,"owner":"hu","amount":62.9,"purpose":"family","spent_on":"2026-09-22","note":"牛胸口油","created_at":"2026-10-10T13:02:45.062054+08:00","kind":"expense"},{"id":28,"owner":"hu","amount":14.8,"purpose":"personal","spent_on":"2026-09-22","note":"打车（做胸）","created_at":"2026-10-10T20:24:14.500457+08:00","kind":"expense"},{"id":29,"owner":"hu","amount":0.5,"purpose":"family","spent_on":"2026-09-22","note":"肯德基","created_at":"2026-10-10T20:24:32.108307+08:00","kind":"expense"},{"id":30,"owner":"hu","amount":8.8,"purpose":"personal","spent_on":"2026-09-23","note":"罗森早饭","created_at":"2026-10-10T20:25:12.887291+08:00","kind":"expense"},{"id":31,"owner":"hu","amount":25.0,"purpose":"income","spent_on":"2026-09-23","note":"宣传册退款","created_at":"2026-10-10T20:25:30.933991+08:00","kind":"income"},{"id":32,"owner":"hu","amount":12.42,"purpose":"personal","spent_on":"2026-09-24","note":"天使之泪多肉","created_at":"2026-10-10T20:26:42.367066+08:00","kind":"expense"},{"id":33,"owner":"hu","amount":14.82,"purpose":"personal","spent_on":"2026-09-24","note":"罗森早饭","created_at":"2026-10-10T20:27:19.976596+08:00","kind":"expense"},{"id":34,"owner":"hu","amount":83.27,"purpose":"family","spent_on":"2026-09-28","note":"小马短袖","created_at":"2026-10-10T20:28:21.618487+08:00","kind":"expense"},{"id":35,"owner":"hu","amount":21.4,"purpose":"personal","spent_on":"2026-09-28","note":"彩叶芋种球","created_at":"2026-10-10T20:29:43.058084+08:00","kind":"expense"},{"id":36,"owner":"hu","amount":14.11,"purpose":"maimai","spent_on":"2026-09-28","note":"发卡","created_at":"2026-10-10T20:30:10.756592+08:00","kind":"expense"},{"id":37,"owner":"hu","amount":0.18,"purpose":"income","spent_on":"2026-09-28","note":"理财","created_at":"2026-10-10T20:31:06.542022+08:00","kind":"income"},{"id":38,"owner":"hu","amount":29.8,"purpose":"personal","spent_on":"2026-09-30","note":"罗森牛奶","created_at":"2026-10-10T20:32:00.083358+08:00","kind":"expense"},{"id":39,"owner":"hu","amount":5.5,"purpose":"personal","spent_on":"2026-09-30","note":"罗森早饭","created_at":"2026-10-10T20:32:16.440896+08:00","kind":"expense"},{"id":40,"owner":"hu","amount":21.78,"purpose":"personal","spent_on":"2026-09-29","note":"罗森早饭","created_at":"2026-10-10T20:33:21.859476+08:00","kind":"expense"},{"id":41,"owner":"hu","amount":7.9,"purpose":"personal","spent_on":"2026-09-29","note":"罗森鸡肉串","created_at":"2026-10-10T20:33:42.174556+08:00","kind":"expense"},{"id":42,"owner":"hu","amount":9.9,"purpose":"family","spent_on":"2026-10-01","note":"胖哥两","created_at":"2026-10-10T20:39:00.182408+08:00","kind":"expense"},{"id":43,"owner":"hu","amount":47.1,"purpose":"personal","spent_on":"2026-10-01","note":"小杨生煎","created_at":"2026-10-10T20:39:25.098211+08:00","kind":"expense"},{"id":44,"owner":"hu","amount":50.0,"purpose":"family","spent_on":"2026-10-02","note":"晴王葡萄","created_at":"2026-10-10T20:39:48.87946+08:00","kind":"expense"},{"id":45,"owner":"hu","amount":300.0,"purpose":"personal","spent_on":"2026-10-03","note":"杜娟结婚礼物-白月光手镯","created_at":"2026-10-10T20:40:21.339012+08:00","kind":"expense"},{"id":46,"owner":"hu","amount":142.82,"purpose":"maimai","spent_on":"2026-10-04","note":"衣服","created_at":"2026-10-10T20:41:07.824724+08:00","kind":"expense"},{"id":47,"owner":"hu","amount":13.0,"purpose":"personal","spent_on":"2026-10-06","note":"好友聚会ktv","created_at":"2026-10-10T20:41:45.254275+08:00","kind":"expense"},{"id":48,"owner":"hu","amount":30.56,"purpose":"personal","spent_on":"2026-10-06","note":"麻辣烫","created_at":"2026-10-10T20:42:12.622015+08:00","kind":"expense"},{"id":49,"owner":"hu","amount":113.6,"purpose":"maimai","spent_on":"2026-10-08","note":"罩衣，鞋子，连裤袜","created_at":"2026-10-10T20:42:56.101314+08:00","kind":"expense"},{"id":50,"owner":"hu","amount":9.0,"purpose":"personal","spent_on":"2026-10-08","note":"罗森早饭","created_at":"2026-10-10T20:43:29.869781+08:00","kind":"expense"},{"id":51,"owner":"hu","amount":9.0,"purpose":"personal","spent_on":"2026-10-09","note":"罗森早饭","created_at":"2026-10-10T20:43:51.706591+08:00","kind":"expense"},{"id":52,"owner":"hu","amount":26.0,"purpose":"family","spent_on":"2026-10-11","note":"乐乐茶","created_at":"2026-10-11T15:19:14.704189+08:00","kind":"expense"},{"id":53,"owner":"hu","amount":3.5,"purpose":"personal","spent_on":"2026-10-11","note":"水蜜桃汁","created_at":"2026-10-11T18:31:47.560308+08:00","kind":"expense"},{"id":54,"owner":"hu","amount":34.48,"purpose":"personal","spent_on":"2026-10-12","note":"罗森早饭","created_at":"2026-10-12T08:40:43.899732+08:00","kind":"expense"},{"id":55,"owner":"hu","amount":13.4,"purpose":"personal","spent_on":"2026-10-13","note":"罗森早饭","created_at":"2026-10-13T11:28:45.781523+08:00","kind":"expense"},{"id":56,"owner":"hu","amount":2.5,"purpose":"personal","spent_on":"2026-10-14","note":"罗森早饭","created_at":"2026-10-14T10:11:22.42173+08:00","kind":"expense"},{"id":57,"owner":"hu","amount":13.5,"purpose":"personal","spent_on":"2026-10-14","note":"肯德基鸡块","created_at":"2026-10-14T20:34:03.601509+08:00","kind":"expense"},{"id":58,"owner":"hu","amount":5.5,"purpose":"personal","spent_on":"2026-10-15","note":"罗森早饭","created_at":"2026-10-15T08:41:20.960755+08:00","kind":"expense"},{"id":59,"owner":"hu","amount":79.9,"purpose":"maimai","spent_on":"2026-10-15","note":"猪猪套装","created_at":"2026-10-15T16:12:15.838072+08:00","kind":"expense"},{"id":60,"owner":"hu","amount":168.0,"purpose":"personal","spent_on":"2026-10-15","note":"海盗世界拼图","created_at":"2026-10-15T17:40:02.885293+08:00","kind":"expense"},{"id":61,"owner":"hu","amount":10.2,"purpose":"personal","spent_on":"2026-10-16","note":"罗森早饭","created_at":"2026-10-16T09:32:31.800779+08:00","kind":"expense"},{"id":62,"owner":"hu","amount":72.4,"purpose":"maimai","spent_on":"2026-10-16","note":"棉柔巾","created_at":"2026-10-16T10:41:58.764107+08:00","kind":"expense"},{"id":63,"owner":"hu","amount":112.0,"purpose":"family","spent_on":"2026-10-17","note":"野鸭中午饭","created_at":"2026-10-17T11:52:20.086545+08:00","kind":"expense"},{"id":64,"owner":"hu","amount":40.12,"purpose":"family","spent_on":"2026-10-17","note":"零食水果","created_at":"2026-10-17T19:16:02.825377+08:00","kind":"expense"},{"id":65,"owner":"hu","amount":95.0,"purpose":"maimai","spent_on":"2026-10-18","note":"果泥","created_at":"2026-10-18T16:07:03.340346+08:00","kind":"expense"},{"id":66,"owner":"hu","amount":13.0,"purpose":"personal","spent_on":"2026-10-18","note":"锅盔","created_at":"2026-10-18T16:07:15.322613+08:00","kind":"expense"},{"id":67,"owner":"hu","amount":9.9,"purpose":"personal","spent_on":"2026-10-19","note":"罗森早饭","created_at":"2026-10-19T11:00:36.175669+08:00","kind":"expense"},{"id":68,"owner":"hu","amount":17.0,"purpose":"family","spent_on":"2026-10-19","note":"茉莉奶白","created_at":"2026-10-19T11:01:02.783905+08:00","kind":"expense"},{"id":69,"owner":"hu","amount":126.0,"purpose":"personal","spent_on":"2026-10-19","note":"出差顺风车","created_at":"2026-10-19T15:13:27.820232+08:00","kind":"expense"},{"id":70,"owner":"hu","amount":500.0,"purpose":"income","spent_on":"2026-10-19","note":"婆婆赠予","created_at":"2026-10-19T15:42:23.972199+08:00","kind":"income"},{"id":71,"owner":"hu","amount":1.58,"purpose":"personal","spent_on":"2026-10-19","note":"电瓶车充电","created_at":"2026-10-20T20:54:19.737489+08:00","kind":"expense"},{"id":72,"owner":"hu","amount":15.98,"purpose":"personal","spent_on":"2026-10-20","note":"罗森早饭","created_at":"2026-10-20T20:54:41.478665+08:00","kind":"expense"},{"id":73,"owner":"hu","amount":30.0,"purpose":"personal","spent_on":"2026-10-20","note":"福斯高速费","created_at":"2026-10-20T20:55:07.912023+08:00","kind":"expense"},{"id":74,"owner":"hu","amount":685.65,"purpose":"maimai","spent_on":"2026-10-20","note":"双十一购物","created_at":"2026-10-20T20:55:51.498101+08:00","kind":"expense"},{"id":75,"owner":"hu","amount":199.2,"purpose":"personal","spent_on":"2026-10-20","note":"福斯回程","created_at":"2026-10-20T21:41:50.151819+08:00","kind":"expense"},{"id":76,"owner":"hu","amount":6.45,"purpose":"personal","spent_on":"2026-10-21","note":"早饭","created_at":"2026-10-21T11:02:59.28552+08:00","kind":"expense"},{"id":77,"owner":"hu","amount":243.26,"purpose":"maimai","spent_on":"2026-10-21","note":"碎碎面，核桃油等","created_at":"2026-10-21T11:03:26.512039+08:00","kind":"expense"},{"id":78,"owner":"hu","amount":162.29,"purpose":"income","spent_on":"2026-10-21","note":"余额宝提现","created_at":"2026-10-21T11:04:31.977888+08:00","kind":"income"},{"id":79,"owner":"hu","amount":4.49,"purpose":"personal","spent_on":"2026-10-22","note":"早饭","created_at":"2026-10-22T08:41:50.434207+08:00","kind":"expense"},{"id":80,"owner":"hu","amount":52.0,"purpose":"maimai","spent_on":"2026-10-22","note":"小马夹","created_at":"2026-10-22T12:34:53.998892+08:00","kind":"expense"},{"id":81,"owner":"hu","amount":5.45,"purpose":"personal","spent_on":"2026-10-23","note":"罗森早饭","created_at":"2026-10-23T08:53:18.660267+08:00","kind":"expense"},{"id":82,"owner":"hu","amount":51.9,"purpose":"maimai","spent_on":"2026-10-23","note":"皮球和洗澡猪猪","created_at":"2026-10-23T14:11:23.24076+08:00","kind":"expense"},{"id":83,"owner":"hu","amount":99.9,"purpose":"maimai","spent_on":"2026-10-23","note":"睡袋","created_at":"2026-10-23T14:11:32.153937+08:00","kind":"expense"},{"id":84,"owner":"hu","amount":34.5,"purpose":"personal","spent_on":"2026-10-23","note":"肯德基","created_at":"2026-10-23T18:02:41.278967+08:00","kind":"expense"},{"id":86,"owner":"hu","amount":600.0,"purpose":"income","spent_on":"2026-10-24","note":"房租退租","created_at":"2026-10-24T20:18:34.372849+08:00","kind":"income"},{"id":87,"owner":"hu","amount":16.33,"purpose":"personal","spent_on":"2026-10-21","note":"打车去做胸","created_at":"2026-10-24T20:21:03.24305+08:00","kind":"expense"},{"id":88,"owner":"hu","amount":500.0,"purpose":"income","spent_on":"2026-10-26","note":"小马支援","created_at":"2026-10-26T19:45:43.447385+08:00","kind":"income"},{"id":89,"owner":"hu","amount":163.2,"purpose":"income","spent_on":"2026-10-27","note":"报销款","created_at":"2026-10-27T10:15:24.569078+08:00","kind":"income"},{"id":90,"owner":"hu","amount":19.8,"purpose":"personal","spent_on":"2026-10-27","note":"罗森早饭","created_at":"2026-10-27T10:15:57.539812+08:00","kind":"expense"},{"id":91,"owner":"hu","amount":20.0,"purpose":"income","spent_on":"2026-10-27","note":"农民补贴","created_at":"2026-10-27T11:10:15.144419+08:00","kind":"income"},{"id":92,"owner":"hu","amount":391.45,"purpose":"maimai","spent_on":"2026-10-27","note":"麦麦照片","created_at":"2026-10-27T11:10:55.46302+08:00","kind":"expense"},{"id":93,"owner":"hu","amount":17.12,"purpose":"personal","spent_on":"2026-10-27","note":"三菱笔","created_at":"2026-10-27T11:11:31.847228+08:00","kind":"expense"},{"id":94,"owner":"hu","amount":14.23,"purpose":"personal","spent_on":"2026-10-27","note":"朱顶红","created_at":"2026-10-27T11:12:02.138293+08:00","kind":"expense"},{"id":95,"owner":"hu","amount":23.45,"purpose":"personal","spent_on":"2026-10-28","note":"牛奶鸡蛋洗洁精","created_at":"2026-10-28T08:39:30.798871+08:00","kind":"expense"},{"id":96,"owner":"hu","amount":121.53,"purpose":"family","spent_on":"2026-10-28","note":"洗衣液","created_at":"2026-10-28T09:07:41.732082+08:00","kind":"expense"},{"id":97,"owner":"hu","amount":14.0,"purpose":"family","spent_on":"2026-10-28","note":"相片盒子","created_at":"2026-10-28T09:27:07.939213+08:00","kind":"expense"},{"id":98,"owner":"hu","amount":18.9,"purpose":"maimai","spent_on":"2026-10-29","note":"麦麦的小球","created_at":"2026-10-29T07:53:29.824025+08:00","kind":"expense"},{"id":99,"owner":"hu","amount":6.4,"purpose":"personal","spent_on":"2026-10-29","note":"罗森早饭","created_at":"2026-10-29T16:31:14.092891+08:00","kind":"expense"},{"id":100,"owner":"hu","amount":14.9,"purpose":"personal","spent_on":"2026-10-29","note":"糖果","created_at":"2026-10-29T16:31:31.228781+08:00","kind":"expense"},{"id":101,"owner":"hu","amount":2.17,"purpose":"personal","spent_on":"2026-10-30","note":"包子","created_at":"2026-10-30T11:37:34.017479+08:00","kind":"expense"},{"id":102,"owner":"hu","amount":8.8,"purpose":"personal","spent_on":"2026-10-30","note":"鸡蛋➕饮品","created_at":"2026-10-30T11:37:46.366739+08:00","kind":"expense"},{"id":103,"owner":"hu","amount":35.0,"purpose":"maimai","spent_on":"2026-10-30","note":"冬天帽子","created_at":"2026-10-30T11:37:58.380825+08:00","kind":"expense"},{"id":104,"owner":"hu","amount":59.8,"purpose":"maimai","spent_on":"2026-10-30","note":"绘本","created_at":"2026-10-30T16:21:59.71139+08:00","kind":"expense"},{"id":105,"owner":"hu","amount":16.01,"purpose":"maimai","spent_on":"2026-10-31","note":"牛油果","created_at":"2026-10-31T09:53:45.165561+08:00","kind":"expense"},{"id":106,"owner":"hu","amount":60.0,"purpose":"family","spent_on":"2026-10-31","note":"蓝莓","created_at":"2026-10-31T09:56:36.272164+08:00","kind":"expense"},{"id":107,"owner":"hu","amount":34.82,"purpose":"personal","spent_on":"2026-10-31","note":"烤鸡大腿","created_at":"2026-10-31T17:53:10.429156+08:00","kind":"expense"},{"id":108,"owner":"hu","amount":10.0,"purpose":"maimai","spent_on":"2026-10-31","note":"麦麦西瓜球","created_at":"2026-10-31T17:53:29.073215+08:00","kind":"expense"},{"id":109,"owner":"hu","amount":18.02,"purpose":"personal","spent_on":"2026-10-29","note":"打车去沈杜公路","created_at":"2026-10-31T20:27:42.1621+08:00","kind":"expense"},{"id":110,"owner":"hu","amount":32.31,"purpose":"maimai","spent_on":"2026-10-31","note":"奶嘴","created_at":"2026-10-31T20:28:13.109623+08:00","kind":"expense"},{"id":111,"owner":"hu","amount":47.9,"purpose":"personal","spent_on":"2026-11-01","note":"喜茶","created_at":"2026-11-01T13:49:48.246182+08:00","kind":"expense"},{"id":112,"owner":"ma","amount":0.5,"purpose":"personal","spent_on":"2026-11-01","note":"丰巢快递费","created_at":"2026-11-01T18:19:26.697963+08:00","kind":"expense"},{"id":113,"owner":"ma","amount":47.9,"purpose":"personal","spent_on":"2026-11-01","note":"汽车充电费","created_at":"2026-11-01T18:22:02.498022+08:00","kind":"expense"},{"id":114,"owner":"ma","amount":68.0,"purpose":"family","spent_on":"2026-11-01","note":"电费","created_at":"2026-11-01T18:23:50.687574+08:00","kind":"expense"},{"id":115,"owner":"ma","amount":220.0,"purpose":"family","spent_on":"2026-11-01","note":"网费","created_at":"2026-11-01T18:25:42.873049+08:00","kind":"expense"},{"id":116,"owner":"ma","amount":7.0,"purpose":"personal","spent_on":"2026-11-02","note":"早饭","created_at":"2026-11-02T08:14:11.153778+08:00","kind":"expense"},{"id":117,"owner":"hu","amount":11.39,"purpose":"personal","spent_on":"2026-11-02","note":"早饭","created_at":"2026-11-02T15:23:04.842028+08:00","kind":"expense"},{"id":118,"owner":"hu","amount":80.0,"purpose":"family","spent_on":"2026-11-02","note":"红莓","created_at":"2026-11-02T15:23:21.045248+08:00","kind":"expense"},{"id":119,"owner":"hu","amount":12.74,"purpose":"personal","spent_on":"2026-11-02","note":"章鱼小子","created_at":"2026-11-02T15:23:35.52076+08:00","kind":"expense"},{"id":120,"owner":"ma","amount":8.5,"purpose":"personal","spent_on":"2026-11-03","note":"早饭","created_at":"2026-11-03T08:06:41.881155+08:00","kind":"expense"},{"id":121,"owner":"hu","amount":24.58,"purpose":"personal","spent_on":"2026-11-03","note":"牛奶","created_at":"2026-11-03T17:05:22.498114+08:00","kind":"expense"},{"id":122,"owner":"hu","amount":6.49,"purpose":"personal","spent_on":"2026-11-03","note":"早饭","created_at":"2026-11-03T17:05:47.431147+08:00","kind":"expense"},{"id":123,"owner":"ma","amount":7.0,"purpose":"personal","spent_on":"2026-11-04","note":"早饭","created_at":"2026-11-04T08:37:27.712606+08:00","kind":"expense"},{"id":124,"owner":"hu","amount":15.4,"purpose":"personal","spent_on":"2026-11-04","note":"酸奶","created_at":"2026-11-04T08:45:18.566733+08:00","kind":"expense"},{"id":125,"owner":"hu","amount":2.95,"purpose":"personal","spent_on":"2026-11-04","note":"包子","created_at":"2026-11-04T08:45:39.867002+08:00","kind":"expense"},{"id":126,"owner":"hu","amount":131.7,"purpose":"maimai","spent_on":"2026-11-04","note":"麦麦衣服","created_at":"2026-11-04T10:08:31.380094+08:00","kind":"expense"},{"id":127,"owner":"hu","amount":132.52,"purpose":"personal","spent_on":"2026-11-04","note":"外套","created_at":"2026-11-04T15:26:27.862823+08:00","kind":"expense"},{"id":128,"owner":"ma","amount":7.0,"purpose":"personal","spent_on":"2026-11-05","note":"早饭","created_at":"2026-11-05T08:11:55.340658+08:00","kind":"expense"},{"id":129,"owner":"hu","amount":5.24,"purpose":"personal","spent_on":"2026-11-05","note":"早饭","created_at":"2026-11-05T09:19:22.393154+08:00","kind":"expense"},{"id":130,"owner":"ma","amount":2.5,"purpose":"personal","spent_on":"2026-11-06","note":"早饭","created_at":"2026-11-06T09:59:15.877493+08:00","kind":"expense"},{"id":131,"owner":"hu","amount":15.7,"purpose":"personal","spent_on":"2026-11-06","note":"营养土","created_at":"2026-11-06T10:14:51.96655+08:00","kind":"expense"},{"id":132,"owner":"hu","amount":14.0,"purpose":"personal","spent_on":"2026-11-06","note":"早饭","created_at":"2026-11-06T10:15:00.653963+08:00","kind":"expense"},{"id":133,"owner":"ma","amount":83.99,"purpose":"personal","spent_on":"2026-11-07","note":"汽车充电","created_at":"2026-11-07T11:03:39.446985+08:00","kind":"expense"},{"id":134,"owner":"ma","amount":4.0,"purpose":"personal","spent_on":"2026-11-07","note":"停车","created_at":"2026-11-07T11:03:48.233799+08:00","kind":"expense"},{"id":135,"owner":"hu","amount":10.0,"purpose":"personal","spent_on":"2026-11-07","note":"关东煮","created_at":"2026-11-07T19:31:31.129148+08:00","kind":"expense"},{"id":136,"owner":"ma","amount":125.5,"purpose":"family","spent_on":"2026-11-08","note":"租房的电费和燃气费","created_at":"2026-11-08T10:24:25.534636+08:00","kind":"expense"},{"id":137,"owner":"ma","amount":11.5,"purpose":"personal","spent_on":"2026-11-08","note":"早饭","created_at":"2026-11-08T10:24:40.192662+08:00","kind":"expense"},{"id":138,"owner":"hu","amount":44.0,"purpose":"personal","spent_on":"2026-11-08","note":"鲜芋仙","created_at":"2026-11-08T16:08:59.674732+08:00","kind":"expense"},{"id":139,"owner":"hu","amount":2.43,"purpose":"personal","spent_on":"2026-11-09","note":"鸡蛋","created_at":"2026-11-09T08:43:01.879185+08:00","kind":"expense"},{"id":140,"owner":"hu","amount":2.93,"purpose":"personal","spent_on":"2026-11-09","note":"肉包","created_at":"2026-11-09T08:43:12.856832+08:00","kind":"expense"},{"id":141,"owner":"hu","amount":57.0,"purpose":"personal","spent_on":"2026-11-08","note":"小蛋糕","created_at":"2026-11-09T08:44:30.109178+08:00","kind":"expense"},{"id":142,"owner":"ma","amount":8.5,"purpose":"personal","spent_on":"2026-11-09","note":"早饭","created_at":"2026-11-09T10:34:43.908911+08:00","kind":"expense"},{"id":143,"owner":"ma","amount":7.0,"purpose":"personal","spent_on":"2026-11-10","note":"早饭","created_at":"2026-11-10T08:09:18.561891+08:00","kind":"expense"},{"id":144,"owner":"hu","amount":20.89,"purpose":"personal","spent_on":"2026-11-10","note":"早饭","created_at":"2026-11-10T08:28:35.967087+08:00","kind":"expense"},{"id":145,"owner":"hu","amount":15.9,"purpose":"personal","spent_on":"2026-11-08","note":"气球","created_at":"2026-11-10T08:30:07.019847+08:00","kind":"expense"},{"id":146,"owner":"hu","amount":136.64,"purpose":"personal","spent_on":"2026-11-10","note":"酸奶和鱼丸","created_at":"2026-11-11T07:06:05.257466+08:00","kind":"expense"},{"id":147,"owner":"ma","amount":7.0,"purpose":"personal","spent_on":"2026-11-11","note":"早饭","created_at":"2026-11-11T08:22:54.167666+08:00","kind":"expense"},{"id":148,"owner":"hu","amount":26.26,"purpose":"personal","spent_on":"2026-11-11","note":"冰皮蛋糕","created_at":"2026-11-11T20:46:30.674477+08:00","kind":"expense"},{"id":149,"owner":"hu","amount":3.0,"purpose":"personal","spent_on":"2026-11-11","note":"包子","created_at":"2026-11-11T20:46:39.811764+08:00","kind":"expense"}]};

  function readStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && (d.ledger_records || d.ledger_cycles)) return d;
      }
    } catch (e) { /* 存储损坏则回落到种子 */ }
    return null;
  }

  /* 本机存储不可用时（无痕模式/隐私设置），不中断应用：内存继续跑，云端同步兜底 */
  var storageWarning = false;

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        ledger_cycles: state.cycles,
        ledger_records: state.records
      }));
      storageWarning = false;
    } catch (e) {
      storageWarning = true;
    }
  }

  function nextId() {
    var max = 0;
    state.records.forEach(function (r) { if (r.id > max) max = r.id; });
    state.cycles.forEach(function (c) { if (c.id > max) max = c.id; });
    return max + 1;
  }

  function sortRecords() {
    state.records.sort(function (a, b) {
      if (a.spent_on !== b.spent_on) return a.spent_on > b.spent_on ? -1 : 1;
      return b.id - a.id;
    });
  }

  function normalizeRecord(r) {
    return {
      id: r.id,
      owner: r.owner,
      amount: Number(r.amount) || 0,
      purpose: r.purpose,
      kind: r.kind === KIND_INCOME ? KIND_INCOME : KIND_EXPENSE,
      spent_on: String(r.spent_on).slice(0, 10),
      note: r.note || '',
      created_at: r.created_at
    };
  }

  function unwrap(res) {
    if (res && res.error) throw res.error;
    return res ? res.data : null;
  }

  function friendlyError(e) {
    var code = e && e.code;
    if (code === 'SDK_LOAD_FAILED') {
      return '云端组件未能加载，页面无法工作。应用已改为本地内置组件，若仍出现此提示，' +
             '通常是浏览器缓存了旧页面，请强制刷新（电脑：Ctrl+F5 / Cmd+Shift+R；手机：清除缓存后重开）。';
    }
    if (code === 'TIMEOUT') {
      return '云端连接超时：请求已发出，但 20 秒内没有返回。请检查网络后点击「重新加载」。';
    }
    var msg = (e && (e.message || e.error_description || e.hint)) || '';
    if (/Failed to fetch|NetworkError|network|Load failed/i.test(msg)) {
      return '网络请求失败，请检查网络连接后重试。已记录的数据不会丢失。';
    }
    if (e && e.code === '42P01') return '云端数据表不存在，请重新初始化账本。';
    if (e && e.code === '42501') return '当前没有读写权限，请联系管理员检查账本配置。';
    return msg || '操作失败，请稍后重试。';
  }

  function normalizeCycle(c) {
    return {
      id: c.id,
      owner: c.owner,
      start_date: String(c.start_date).slice(0, 10),
      end_date: String(c.end_date).slice(0, 10),
      initial_amount: Number(c.initial_amount) || 0
    };
  }

  /* ------------------------------------------------------------------
   * GitHub 同步层
   * ------------------------------------------------------------------ */
  var remoteSha = null;        // ledger.json 当前 commit sha（写入时防冲突用）
  var pushTimer = null;        // 写入防抖定时器
  var pushDepth = 0;           // 冲突重试层数（防无限递归）
  var syncing = false;
  var syncError = null;

  function ghApiUrl() {
    return 'https://api.github.com/repos/' + GH.owner + '/' + GH.repo + '/contents/' + GH.file;
  }

  function ghApiHeaders() {
    var h = { 'Accept': 'application/vnd.github+json' };
    var t = ghGetToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  function ghRawUrl() {
    return 'https://raw.githubusercontent.com/' + GH.owner + '/' + GH.repo + '/' +
      GH.branch + '/' + GH.file + '?t=' + Date.now();          // 时间戳绕过 CDN 缓存
  }

  function b64encodeUtf8(s) {
    return btoa(unescape(encodeURIComponent(s)));
  }

  function b64decodeUtf8(b64) {
    var bytes = Uint8Array.from(atob(String(b64).replace(/\n/g, '')), function (c) { return c.charCodeAt(0); });
    return new TextDecoder('utf-8').decode(bytes);
  }

  /** 带超时的 fetch：国内网络连 GitHub 可能长时间挂起，超时后走备用通道 */
  function fetchWithTimeout(url, opts, ms) {
    opts = opts || {};
    if (typeof AbortController === 'undefined') return fetch(url, opts);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { try { ctrl.abort(); } catch (e2) { /* 忽略 */ } }, ms || 15000);
    opts.signal = ctrl.signal;
    return fetch(url, opts).then(
      function (res) { clearTimeout(timer); return res; },
      function (err) { clearTimeout(timer); throw err; }
    );
  }

  /** 只取 ledger.json 的 sha（写入前置检查用），文件不存在返回 null */
  async function loadSha() {
    var res = await fetchWithTimeout(ghApiUrl() + '?ref=' + GH.branch, { headers: ghApiHeaders() });
    if (res.status === 404) { remoteSha = null; return null; }
    if (!res.ok) throw new Error('GitHub 读取失败（HTTP ' + res.status + '）');
    var j = await res.json();
    remoteSha = j.sha;
    return j.sha;
  }

  /**
   * 拉取云端 ledger.json。
   * 返回数据对象；云端没有该文件时返回 null。
   * 注意：优先走 Contents API（国内网络对 api.github.com 可达性优于 raw.githubusercontent.com），
   * raw 仅在 API 意外失败时作为备用通道。
   */
  async function fetchRemote() {
    // 主通道：Contents API
    try {
      var res = await fetchWithTimeout(ghApiUrl() + '?ref=' + GH.branch, { headers: ghApiHeaders() });
      if (res.ok) {
        var j = await res.json();
        remoteSha = j.sha;
        return JSON.parse(b64decodeUtf8(j.content));
      }
      if (res.status === 404) { remoteSha = null; return null; }
      throw new Error('GitHub 读取失败（HTTP ' + res.status + '）');
    } catch (e) {
      if (e && /^GitHub 读取失败/.test(e.message || '')) throw e;   // API 明确报错则不降级
    }

    // 备用通道：raw
    try {
      var res2 = await fetchWithTimeout(ghRawUrl(), { cache: 'no-store' }, 8000);
      if (res2.ok) {
        var txt = await res2.text();
        if (txt.trim()) {
          await loadSha();
          return JSON.parse(txt);
        }
      }
      if (res2.status === 404) { remoteSha = null; return null; }
    } catch (e2) { /* raw 也失败 → 抛网络错误 */ }

    throw new Error('网络请求失败，请检查网络连接后重试');
  }

  /** 把云端数据合并进本地状态：按 id 并集，id 冲突时以云端为准 */
  function mergeRemote(remote) {
    if (!remote) return false;
    var changed = false;
    var i, n, found;

    var rRecs = Array.isArray(remote.ledger_records) ? remote.ledger_records : [];
    rRecs.forEach(function (r) {
      n = normalizeRecord(r);
      found = null;
      for (i = 0; i < state.records.length; i++) {
        if (state.records[i].id === n.id) { found = state.records[i]; break; }
      }
      if (!found) { state.records.push(n); changed = true; }
      else if (JSON.stringify(found) !== JSON.stringify(n)) {
        state.records[state.records.indexOf(found)] = n; changed = true;
      }
    });

    var rCycs = Array.isArray(remote.ledger_cycles) ? remote.ledger_cycles : [];
    rCycs.forEach(function (c) {
      n = normalizeCycle(c);
      found = null;
      for (i = 0; i < state.cycles.length; i++) {
        if (state.cycles[i].id === n.id) { found = state.cycles[i]; break; }
      }
      if (!found) { state.cycles.push(n); changed = true; }
      else if (JSON.stringify(found) !== JSON.stringify(n)) {
        state.cycles[state.cycles.indexOf(found)] = n; changed = true;
      }
    });

    if (changed) {
      sortRecords();
      state.cycles.sort(function (a, b) { return a.start_date < b.start_date ? 1 : -1; });
      persist();
    }
    return changed;
  }

  /** 把本地全部数据写回仓库（一次 commit）。首次写入需要本机配置 Token。 */
  async function pushRemote(message, depth) {
    if (syncing) return;
    if (!ghGetToken()) {
      var t = window.prompt(
        '首次同步：请粘贴 GitHub Token（github_pat_ 开头）。\n' +
        '只保存在本机浏览器的 localStorage，不会出现在公开代码里。\n' +
        '点「取消」= 暂不同步，账目仍保存在本机。', '');
      if (!t || !String(t).trim()) {
        syncError = new Error('未配置同步密钥，账目暂时只保存在本机（可点页脚「同步密钥」补配）');
        updateFooter();
        return;
      }
      ghSetToken(t);
    }
    syncing = true; syncError = null; updateFooter();
    depth = depth || 0;
    try {
      if (remoteSha === null) await loadSha();
      var body = {
        message: message || ('账目更新 ' + new Date().toISOString().slice(0, 19).replace('T', ' ')),
        content: b64encodeUtf8(JSON.stringify({
          ledger_cycles: state.cycles,
          ledger_records: state.records,
          synced_at: new Date().toISOString()
        }, null, 2)),
        branch: GH.branch
      };
      if (remoteSha) body.sha = remoteSha;
      var res = await fetchWithTimeout(ghApiUrl(), { method: 'PUT', headers: ghApiHeaders(), body: JSON.stringify(body) }, 20000);

      if (res.status === 409 || res.status === 422) {
        // sha 已过期（别处先写入了）：拉云端 → 合并 → 重试
        if (depth >= 2) throw new Error('云端冲突多次合并失败，请点「刷新」后重试');
        var remote = await fetchRemote();
        if (remote) mergeRemote(remote);
        remoteSha = null;
        return pushRemote(message, depth + 1);
      }
      if (!res.ok) throw new Error('GitHub 写入失败（HTTP ' + res.status + '）');
      var j = await res.json();
      remoteSha = j.content && j.content.sha ? j.content.sha : null;
      state.lastSync = new Date();
    } catch (e) {
      syncError = e;
    } finally {
      syncing = false;
      updateFooter();
    }
  }

  /** 本地改动后的防抖自动上传：连续操作合并成一次 commit */
  function queuePush(message) {
    updateFooter();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushRemote(message, 0); }, 1200);
  }

  /** 后台静默拉取云端最新数据（打开页面 / 点刷新时用）。返回云端数据（无则 null） */
  async function pullRemote(showToast) {
    try {
      var remote = await fetchRemote();
      var changed = mergeRemote(remote);
      if (remote) {
        state.lastSync = new Date();
        syncError = null;
        state.error = null;
        render();
        updateFooter();
        if (showToast) toast(changed ? '已拉取并合并云端最新账目' : '已是最新，无新改动', 'ok');
      } else if (showToast) {
        toast('云端暂无数据文件', 'ok');
      }
      return remote || null;
    } catch (e) {
      syncError = e;
      updateFooter();
      if (showToast) toast('云端拉取失败：' + (e.message || e), 'err');
      return 'fail';
    }
  }

  async function loadData() {
    var d = readStore();
    if (!d) {
      state.cycles = SEED.ledger_cycles.map(normalizeCycle);
      state.records = SEED.ledger_records.map(normalizeRecord);
    } else {
      state.cycles = (d.ledger_cycles || []).map(normalizeCycle);
      state.records = (d.ledger_records || []).map(normalizeRecord);
    }
    sortRecords();
    state.cycles.sort(function (a, b) { return a.start_date < b.start_date ? 1 : -1; });
    persist();
    state.lastSync = new Date();
  }  async function insertRecord(payload) {
    var row = normalizeRecord(Object.assign({ id: nextId(), created_at: new Date().toISOString() }, payload));
    state.records.push(row);
    sortRecords();
    persist();
    queuePush('新增记录：' + (row.note || row.purpose) + ' ' + money(row.amount));
    return row;
  }

  async function updateRecord(id, payload) {
    var idx = -1;
    for (var i = 0; i < state.records.length; i++) { if (state.records[i].id === id) { idx = i; break; } }
    if (idx === -1) throw new Error('修改失败：记录不存在。');
    var row = normalizeRecord(Object.assign({}, state.records[idx], payload, { id: id }));
    state.records.splice(idx, 1, row);
    sortRecords();
    persist();
    queuePush('修改记录 #' + id + '：' + (row.note || row.purpose) + ' ' + money(row.amount));
    return row;
  }

  async function removeRecord(id) {
    var idx = -1;
    for (var i = 0; i < state.records.length; i++) { if (state.records[i].id === id) { idx = i; break; } }
    if (idx === -1) throw new Error('删除失败：记录不存在。');
    state.records.splice(idx, 1);
    persist();
    queuePush('删除记录 #' + id);
    return true;
  }

  async function saveCycle(owner, cyc, amount) {
    var found = null;
    for (var i = 0; i < state.cycles.length; i++) {
      if (state.cycles[i].owner === owner && state.cycles[i].start_date === cyc.start) { found = state.cycles[i]; break; }
    }
    if (found) {
      found.initial_amount = amount;
      found.end_date = cyc.end;
      persist();
      queuePush('调整期初资金：' + owner + ' ' + money(amount));
      return found;
    }
    var row = normalizeCycle({ id: nextId(), owner: owner, start_date: cyc.start, end_date: cyc.end, initial_amount: amount });
    state.cycles.push(row);
    state.cycles.sort(function (a, b) { return a.start_date < b.start_date ? 1 : -1; });
    persist();
    queuePush('录入期初资金：' + owner + ' ' + money(amount));
    return row;
  }

  /* ------------------------------------------------------------------ *
   * 6. 派生数据计算
   * ------------------------------------------------------------------ */

  /**
   * 计算某成员当前账期的完整视图。
   * 日均可用花费 = 剩余资金 ÷ 剩余天数（不含今天）
   */
  function memberView(key, today) {
    var member = MEMBER_MAP[key];
    var cyc = cycleFor(member.anchorDay, today);

    var cycleRow = null;
    for (var i = 0; i < state.cycles.length; i++) {
      if (state.cycles[i].owner === key && state.cycles[i].start_date === cyc.start) { cycleRow = state.cycles[i]; break; }
    }
    var hasInitial = !!cycleRow;
    var initial = hasInitial ? cycleRow.initial_amount : 0;

    var list = state.records.filter(function (r) {
      return r.owner === key && r.spent_on >= cyc.start && r.spent_on <= cyc.end;
    }).sort(function (a, b) {
      if (a.spent_on !== b.spent_on) return a.spent_on < b.spent_on ? -1 : 1;
      return a.id - b.id;
    });

    // 逐笔累计（支出减、收入加），并计算「该笔记账后的日均可用」
    var running = initial;
    var rows = list.map(function (r) {
      running += isIncomeRow(r) ? r.amount : -r.amount;
      var left = Math.max(daysBetween(r.spent_on, cyc.end), 0);
      return Object.assign({}, r, {
        afterBalance: running,
        afterDaily: left > 0 ? running / left : running,
        afterDays: left
      });
    });

    var spent = rows.reduce(function (s, r) { return s + (isIncomeRow(r) ? 0 : r.amount); }, 0);
    var income = rows.reduce(function (s, r) { return s + (isIncomeRow(r) ? r.amount : 0); }, 0);
    var remaining = initial + income - spent;
    var remainingDays = Math.max(daysBetween(today, cyc.end), 0);
    var daily = hasInitial ? (remainingDays > 0 ? remaining / remainingDays : remaining) : null;

    var byPurpose = {};
    PURPOSES.forEach(function (p) { byPurpose[p.key] = 0; });
    rows.forEach(function (r) {
      if (isIncomeRow(r)) return;                              // 收入不计入用途分布
      if (byPurpose[r.purpose] === undefined) byPurpose[r.purpose] = 0;
      byPurpose[r.purpose] += r.amount;
    });

    return {
      member: member,
      cycle: cyc,
      hasInitial: hasInitial,
      initial: initial,
      rows: rows.slice().reverse(),   // 展示用：新的在前
      rowsAsc: rows,
      spent: spent,
      income: income,
      remaining: remaining,
      remainingDays: remainingDays,
      daily: daily,
      over: hasInitial && remaining < 0,
      byPurpose: byPurpose,
      count: rows.filter(function (r) { return !isIncomeRow(r); }).length,
      totalCount: rows.length
    };
  }

  /** 历史账期分组（用于「历史」视图） */
  function historyGroups(key, today) {
    var member = MEMBER_MAP[key];
    var current = cycleFor(member.anchorDay, today);
    var map = {};

    state.records.forEach(function (r) {
      if (r.owner !== key) return;
      var cyc = cycleFor(member.anchorDay, r.spent_on);
      var gk = cyc.start;
      if (!map[gk]) map[gk] = { cycle: cyc, rows: [] };
      map[gk].rows.push(r);
    });

    // 补上已登记但尚无流水的账期
    state.cycles.forEach(function (c) {
      if (c.owner !== key) return;
      if (!map[c.start_date]) map[c.start_date] = { cycle: { start: c.start_date, end: c.end_date }, rows: [] };
    });

    return Object.keys(map).sort().reverse().map(function (gk) {
      var g = map[gk];
      var cycleRow = null;
      for (var i = 0; i < state.cycles.length; i++) {
        if (state.cycles[i].owner === key && state.cycles[i].start_date === g.cycle.start) { cycleRow = state.cycles[i]; break; }
      }
      var initial = cycleRow ? cycleRow.initial_amount : 0;
      var asc = g.rows.slice().sort(function (a, b) {
        if (a.spent_on !== b.spent_on) return a.spent_on < b.spent_on ? -1 : 1;
        return a.id - b.id;
      });
      var running = initial;
      var rows = asc.map(function (r) {
        running += isIncomeRow(r) ? r.amount : -r.amount;
        var left = Math.max(daysBetween(r.spent_on, g.cycle.end), 0);
        return Object.assign({}, r, {
          afterBalance: running,
          afterDaily: left > 0 ? running / left : running,
          afterDays: left
        });
      });
      var spent = rows.reduce(function (s, r) { return s + (isIncomeRow(r) ? 0 : r.amount); }, 0);
      var income = rows.reduce(function (s, r) { return s + (isIncomeRow(r) ? r.amount : 0); }, 0);
      return {
        cycle: g.cycle,
        isCurrent: g.cycle.start === current.start,
        hasInitial: !!cycleRow,
        initial: initial,
        spent: spent,
        income: income,
        remaining: initial + income - spent,
        rows: rows.slice().reverse()
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * 7. 渲染
   * ------------------------------------------------------------------ */
  function skeleton() {
    return '<div class="stack"><div class="sk-block sk-1"></div>' +
           '<div class="sk-block sk-2"></div><div class="sk-block sk-3"></div></div>';
  }

  function errorBlock(msg) {
    return '<div class="stack"><div class="state-box err">' +
      '<div class="sb-icon">!</div>' +
      '<h3>数据读取失败</h3>' +
      '<p>' + esc(msg) + '</p>' +
      '<div class="actions"><button class="btn btn-primary" data-action="reload">重新加载</button></div>' +
      '</div></div>';
  }

  function emptyBlock(icon, title, sub) {
    return '<div class="empty"><span class="e-icon">' + icon + '</span>' + esc(title) +
           (sub ? '<br><span style="opacity:.8;font-size:12px">' + esc(sub) + '</span>' : '') + '</div>';
  }

  /* -------- 主视觉卡片 -------- */
  function heroHtml(v, opts) {
    opts = opts || {};
    var roleClass = opts.roleClass || '';
    var daily = opts.dailyOverride !== undefined ? opts.dailyOverride : v.daily;
    var remainingDays = opts.remainingDays !== undefined ? opts.remainingDays : v.remainingDays;

    // 主视觉：剩余可用（大数字）
    var valueHtml, subHtml;
    if (!v.hasInitial) {
      valueHtml = '<span class="hero-value">— —</span>';
      subHtml = '<span class="hero-sub">尚未记录本期初始资金，请先录入</span>';
    } else {
      var neg = v.remaining < 0;
      valueHtml = '<span class="hero-value"' + (neg ? ' style="color:#FFDDE3"' : '') + '>' +
        money(v.remaining).replace('¥', '<span class="cur">¥</span>') + '</span>';
      if (remainingDays === 0) {
        subHtml = '<span class="hero-sub' + (neg ? ' warn' : '') + '">今天是本账期最后一天，剩余资金可全部使用</span>';
      } else {
        subHtml = '<span class="hero-sub' + (neg ? ' warn' : '') + '">到本账期结束还有 ' + remainingDays +
                  ' 天（不含今天）' + (neg ? ' · 已超支 ' + money(Math.abs(v.remaining)) : '') + '</span>';
      }
    }

    var dailyHtml = (daily === null || daily === undefined) ? '—' : money(daily);

    // 有收入时增加一列，保证「期初 + 收入 − 支出 = 剩余可用」可核对
    var incomeStat = (v.income > 0)
      ? '<div><span>本期收入</span><b>' + money(v.income) + '</b></div>'
      : '';

    var pct = v.hasInitial && v.initial > 0
      ? Math.min(Math.max((v.remaining / v.initial) * 100, 0), 100)
      : 0;

    // 期初录入按钮：放在「剩余可用」数字右侧，与上方账期日期右对齐
    var initChip = '<button type="button" class="hero-init' + (v.hasInitial ? '' : ' is-empty') +
      '" data-action="set-initial" data-member="' + v.member.key + '">' +
      (v.hasInitial
        ? '<span class="hi-label">期初</span>' +
          '<span class="hi-value">' + money(v.initial) + '</span>' +
          '<span class="hi-edit">修改</span>'
        : '<span class="hi-value">录入期初</span>') +
    '</button>';

    return '' +
      '<section class="hero ' + roleClass + (opts.roleName ? ' role-' + opts.roleName : '') + '">' +
        '<div class="hero-top">' +
          '<span class="hero-role">' + esc(opts.roleLabel || v.member.name) + '</span>' +
          '<span class="hero-range">' + esc(cycleLabel(v.cycle)) + '</span>' +
        '</div>' +
        '<div class="hero-main">' +
          '<span class="hero-label">剩余可用</span>' +
          '<div class="hero-line">' + valueHtml + initChip + '</div>' +
          subHtml +
        '</div>' +
        '<div class="hero-stats' + (v.income > 0 ? ' has-income' : '') + '">' +
          '<div><span>期初资金</span><b>' + (v.hasInitial ? money(v.initial) : '—') + '</b></div>' +
          '<div><span>已支出</span><b>' + money(v.spent) + '</b></div>' +
          incomeStat +
          '<div><span>日均可用花费</span><b>' + dailyHtml + '</b></div>' +
        '</div>' +
        '<div class="hero-bar' + (v.over ? ' over' : '') + '"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '</section>';
  }

  /* -------- 用途分布 -------- */
  function categoryHtml(v) {
    var total = v.spent;
    var cells = PURPOSES.map(function (p) {
      var amt = v.byPurpose[p.key] || 0;
      var pct = total > 0 ? (amt / total) * 100 : 0;
      return '<div class="cat-cell">' +
        '<span class="cat-name"><i style="background:' + p.color + '"></i>' + esc(p.name) + '</span>' +
        '<b class="cat-amt">' + money(amt) + '</b>' +
        '<span class="cat-pct">' + pct.toFixed(0) + '%</span>' +
      '</div>';
    }).join('');

    var bars = total > 0 ? PURPOSES.map(function (p) {
      var amt = v.byPurpose[p.key] || 0;
      var w = (amt / total) * 100;
      return w > 0 ? '<i style="width:' + w.toFixed(2) + '%;background:' + p.color + '"></i>' : '';
    }).join('') : '';

    return '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">用途分布</h2>' +
      '<span class="card-note">共 ' + v.count + ' 笔 · 合计 ' + money(total) + '</span></div>' +
      '<div class="cat-grid">' + cells + '</div>' +
      (bars ? '<div class="bar-track">' + bars + '</div>' : '') +
    '</div>';
  }

  /* -------- 记录行 -------- */
  function recordRowHtml(r, opts) {
    opts = opts || {};
    var income = isIncomeRow(r);
    var p = PURPOSE_MAP[r.purpose] || { name: r.purpose || '未分类', color: '#94a3b8' };
    var tag = '';
    if (opts.showMember) {
      var m = MEMBER_MAP[r.owner] || { name: r.owner, accent: '#64748b', soft: '#f1f5f9' };
      tag = '<span class="member-tag" style="background:' + m.soft + ';color:' + m.accent + '">' + esc(m.name) + '</span>';
    }
    var note = r.note ? '<span class="rec-note">' + esc(r.note) + '</span>' : '';
    var badgeColor = income ? INCOME_COLOR : p.color;
    var badgeText = income ? '收' : p.name.slice(0, 1);
    var titleText = income ? '收入' : p.name;
    var amtText = (income ? '+' : '') + money(r.amount);

    return '<div class="rec' + (income ? ' rec-income' : '') + '">' +
      '<span class="rec-badge" style="background:' + badgeColor + '">' + esc(badgeText) + '</span>' +
      '<div class="rec-body">' +
        '<div class="rec-line1">' + tag + '<span class="rec-purpose">' + esc(titleText) + '</span>' + note + '</div>' +
        '<div class="rec-line2">' +
          (typeof r.afterBalance === 'number' ? '余额 ' + money(r.afterBalance) : '') +
        '</div>' +
      '</div>' +
      '<div class="rec-right">' +
        '<span class="rec-amt' + (income ? ' rec-amt-income' : '') + '">' + amtText + '</span>' +
        '<span class="rec-acts">' +
          '<button class="btn btn-ghost btn-sm" data-action="edit-record" data-id="' + r.id + '">改</button>' +
          '<button class="btn btn-ghost btn-sm" data-action="del-record" data-id="' + r.id + '">删</button>' +
        '</span>' +
      '</div>' +
    '</div>';
  }

  /* -------- 记一笔支出 + 支出明细（合并卡片） -------- */
  function ledgerCardHtml(memberKey) {
    var v = memberView(memberKey, todayIso());
    var seg = '<div class="seg">' +
      '<button data-action="range" data-mode="current" aria-pressed="' + (state.rangeMode === 'current' ? 'true' : 'false') + '">本期</button>' +
      '<button data-action="range" data-mode="history" aria-pressed="' + (state.rangeMode === 'current' ? 'false' : 'true') + '">历史</button>' +
    '</div>';

    var body;
    if (state.rangeMode === 'current') {
      body = v.rows.length
        ? dayGroupedRowsHtml(v.rows)
        : emptyBlock('🗒', '本期还没有支出记录', '点击上方「＋ 添加」开始记一笔');
    } else {
      var groups = historyGroups(v.member.key, todayIso());
      if (!groups.length) {
        body = emptyBlock('🗂', '还没有历史账期数据', '完成一次记账后即可在此查看');
      } else {
        body = groups.map(function (g) {
          var head = '<div class="group-head">' +
            '<span class="g-title">' + esc(cycleTitle(v.member, g.cycle)) +
              (g.isCurrent ? ' <span style="font-size:11px;font-weight:600;color:var(--accent)">当前</span>' : '') + '</span>' +
            '<span class="g-meta">期初 ' + (g.hasInitial ? money(g.initial) : '—') +
              (g.income > 0 ? ' · 收入 ' + money(g.income) : '') +
              ' · 支出 ' + money(g.spent) +
              ' · 结余 ' + (g.hasInitial ? money(g.remaining) : '—') + '</span>' +
          '</div>';
          var rows = g.rows.length
            ? dayGroupedRowsHtml(g.rows)
            : '<div class="empty" style="padding:12px 4px">该账期无支出记录</div>';
          return head + rows;
        }).join('');
      }
    }

    return '<div class="card">' +
      '<div class="card-head"><h2 class="card-title">记一笔支出</h2>' +
        '<button class="btn btn-primary btn-sm" data-action="new-record" data-member="' + memberKey + '">＋ 添加</button></div>' +
      '<div class="ledger-divider"><span class="ld-label">支出明细</span>' + seg + '</div>' +
      '<div class="ledger-body" id="ledgerBody">' + body + '</div>' +
    '</div>';
  }

  /* -------- 可视化：按周期支出的柱状图（按年切换，展示该年全部账期） -------- */
  function cycleBarChartHtml(member, cycles, year) {
    if (!cycles.length) {
      return emptyBlock('📊', '暂无账期数据', '记一笔支出后即可看到各周期支出');
    }

    // 全部账期按起始日期升序（旧 → 新）
    var all = cycles.slice().sort(function (a, b) {
      return a.cycle.start < b.cycle.start ? -1 : (a.cycle.start > b.cycle.start ? 1 : 0);
    });

    // 覆盖到的年份（降序，最新在前）
    var years = [];
    all.forEach(function (c) {
      var y = parseYmd(c.cycle.start).getFullYear();
      if (years.indexOf(y) === -1) years.push(y);
    });
    years.sort(function (a, b) { return b - a; });

    var cur = year || state.chartYear;
    if (years.indexOf(cur) === -1) cur = years[0];
    // 注意：渲染路径不写回 state.chartYear（马/胡两张图共享状态，各自回退，互不污染）

    // 该年内的账期（马 1 日 / 胡 15 日 起算的每个自然账期）
    var list = all.filter(function (c) { return parseYmd(c.cycle.start).getFullYear() === cur; });

    var yearSeg = years.length > 1
      ? '<div class="seg seg-year">' + years.map(function (y) {
          return '<button data-action="chart-year" data-year="' + y + '" aria-pressed="' +
            (y === cur ? 'true' : 'false') + '">' + y + ' 年</button>';
        }).join('') + '</div>'
      : '<span class="card-note">' + cur + ' 年</span>';

    var maxVal = list.reduce(function (m, c) { return Math.max(m, c.spent); }, 0);
    var todayCyc = cycleFor(member.anchorDay, todayIso());

    var cols = list.map(function (c) {
      var startIso = c.cycle.start;
      var h = maxVal > 0 ? (c.spent / maxVal) * 100 : 0;
      var isNow = startIso === todayCyc.start;
      var isFuture = startIso > todayCyc.start;
      var d = parseYmd(startIso);
      var name = (d.getMonth() + 1) + '月' + d.getDate() + '日';
      var sub = isNow ? '当前账期'
        : isFuture ? '未开始'
        : (c.rows ? c.rows.length : 0) + ' 笔';
      return '<div class="cb-col">' +
        '<div class="cb-amt">' + (c.spent > 0 ? money(c.spent) : '—') + '</div>' +
        '<div class="cb-stack' + (c.spent > 0 ? '' : ' empty') + '">' +
          (h > 0 ? '<i style="height:' + h.toFixed(1) + '%;background:' + member.accent + '"></i>' : '') +
        '</div>' +
        '<div class="cb-name">' + esc(name) + '</div>' +
        '<div class="cb-sub' + (isNow ? ' now' : '') + '">' + esc(sub) + '</div>' +
      '</div>';
    }).join('');

    var yearTotal = list.reduce(function (s, c) { return s + c.spent; }, 0);

    return yearSeg +
      '<div class="cycle-bars">' + cols + '</div>' +
      '<div class="card-note" style="margin-top:10px;display:block">' +
        cur + ' 年共 ' + list.length + ' 个账期 · 合计 ' + money(yearTotal) +
        ' · 柱高按年内最高账期等比绘制</div>';
  }

  /* -------- 成员视图 -------- */
  function renderMember(key) {
    var v = memberView(key, todayIso());
    return '<div class="stack">' +
      heroHtml(v, { roleName: key, roleLabel: v.member.name + ' · 本期' }) +
      categoryHtml(v) +
      ledgerCardHtml(key) +
    '</div>';
  }

  /* -------- 总览视图 -------- */
  function renderOverview() {
    var today = todayIso();
    var views = MEMBERS.map(function (m) { return memberView(m.key, today); });

    var initSum = views.reduce(function (s, v) { return s + (v.hasInitial ? v.initial : 0); }, 0);
    var spentSum = views.reduce(function (s, v) { return s + v.spent; }, 0);
    var incomeSum = views.reduce(function (s, v) { return s + v.income; }, 0);
    var remainSum = views.reduce(function (s, v) { return s + (v.hasInitial ? v.remaining : 0); }, 0);
    var allHaveInit = views.every(function (v) { return v.hasInitial; });
    var dailySum = allHaveInit ? views.reduce(function (s, v) { return s + (v.daily || 0); }, 0) : null;

    var combined = {
      member: { name: '总览' },
      cycle: { start: today, end: today },
      hasInitial: allHaveInit,
      initial: initSum,
      spent: spentSum,
      remaining: remainSum,
      remainingDays: views[0].remainingDays,
      daily: dailySum,
      over: allHaveInit && remainSum < 0
    };

    var hero = '' +
      '<section class="hero role-all">' +
        '<div class="hero-top">' +
          '<span class="hero-role">两人合计</span>' +
          '<span class="hero-range">各自当前账期</span>' +
        '</div>' +
        '<div class="hero-main">' +
          '<span class="hero-label">剩余可用合计</span>' +
          (allHaveInit
            ? '<span class="hero-value"' + (remainSum < 0 ? ' style="color:#FFDDE3"' : '') + '>' +
                money(remainSum).replace('¥', '<span class="cur">¥</span>') + '</span>' +
              '<span class="hero-sub' + (remainSum < 0 ? ' warn' : '') + '">' +
                (remainSum < 0 ? '已超支 ' + money(Math.abs(remainSum)) : '两人剩余资金合计') + '</span>'
            : '<span class="hero-value">— —</span><span class="hero-sub">双方账期初始资金未齐全</span>') +
        '</div>' +
        '<div class="hero-stats' + (incomeSum > 0 ? ' has-income' : '') + '">' +
          '<div><span>期初合计</span><b>' + money(initSum) + '</b></div>' +
          '<div><span>已支出</span><b>' + money(spentSum) + '</b></div>' +
          (incomeSum > 0 ? '<div><span>收入合计</span><b>' + money(incomeSum) + '</b></div>' : '') +
          '<div><span>合计日均可用花费</span><b>' + (dailySum === null ? '—' : money(dailySum)) + '</b></div>' +
        '</div>' +
      '</section>';

    var minis = '<div class="mini-grid">' + views.map(function (v) {
      var m = v.member;
      var big = v.hasInitial
        ? money(v.remaining).replace('¥', '<span class="cur">¥</span>')
        : '未录入期初';
      // 有收入时小字改为「收入 · 支出 · 剩余天数」，避免「期初 − 支出 ≠ 结余」的困惑
      var meta = v.income > 0
        ? '收入 ' + moneyShort(v.income) + '<span class="ms">·</span>支出 ' + moneyShort(v.spent) +
          '<span class="ms">·</span>剩 ' + v.remainingDays + ' 天'
        : '期初 ' + (v.hasInitial ? moneyShort(v.initial) : '—') + '<span class="ms">·</span>支出 ' + moneyShort(v.spent) +
          '<span class="ms">·</span>剩 ' + v.remainingDays + ' 天';
      return '<div class="mini' + (v.hasInitial ? '' : ' is-empty') + (v.income > 0 ? ' has-income' : '') +
          '" style="--m-accent:' + m.accent + '">' +
        '<div class="m-name">' + esc(m.name) +
          '<em>' + esc(cycleLabel(v.cycle)) + '</em></div>' +
        '<div class="m-big' + (v.hasInitial && v.remaining < 0 ? ' neg' : '') + '">' + big + '</div>' +
        '<div class="m-meta">' + meta + '</div>' +
      '</div>';
    }).join('') + '</div>';

    // 用途合计
    var purposeTotal = spentSum;
    var purposeCells = PURPOSES.map(function (p) {
      var amt = views.reduce(function (s, v) { return s + (v.byPurpose[p.key] || 0); }, 0);
      var pct = purposeTotal > 0 ? (amt / purposeTotal) * 100 : 0;
      return '<div class="cat-cell">' +
        '<span class="cat-name"><i style="background:' + p.color + '"></i>' + esc(p.name) + '</span>' +
        '<b class="cat-amt">' + money(amt) + '</b>' +
        '<span class="cat-pct">' + pct.toFixed(0) + '%</span>' +
      '</div>';
    }).join('');
    var purposeBars = purposeTotal > 0 ? PURPOSES.map(function (p) {
      var amt = views.reduce(function (s, v) { return s + (v.byPurpose[p.key] || 0); }, 0);
      var w = (amt / purposeTotal) * 100;
      return w > 0 ? '<i style="width:' + w.toFixed(2) + '%;background:' + p.color + '"></i>' : '';
    }).join('') : '';

    var detailRows = views.map(function (v) {
      return '<div class="kv"><span class="k">' + esc(v.member.name) + ' · ' + esc(cycleTitle(v.member, v.cycle)) + '</span>' +
        '<span class="v">支出 ' + money(v.spent) +
        (v.income > 0 ? ' · 收入 ' + money(v.income) : '') + '</span></div>';
    }).join('');

    // 可视化图表：马 / 胡 各自「按周期支出的柱状图」（可按年切换）
    // 数据源 = 期初账期行 ∪ 有支出记录的账期（并集去重），按起始日期排序
    var barCards = views.map(function (v) {
      var k = v.member.key;
      var anchor = v.member.anchorDay;
      var seen = {};
      var cycles = [];

      function pushCycle(cyc, rows) {
        if (seen[cyc.start]) return;
        seen[cyc.start] = 1;
        cycles.push({
          cycle: cyc,
          spent: rows.reduce(function (s, r) { return s + (isIncomeRow(r) ? 0 : (Number(r.amount) || 0)); }, 0),
          income: rows.reduce(function (s, r) { return s + (isIncomeRow(r) ? (Number(r.amount) || 0) : 0); }, 0),
          rows: rows
        });
      }

      state.cycles.forEach(function (c) {
        if (c.owner !== k) return;
        var cyc = { start: c.start_date, end: c.end_date };
        var view = memberView(k, cyc.end);
        if (view.cycle.start !== cyc.start) return;          // 异常行防御
        pushCycle(cyc, view.rowsAsc);
      });
      state.records.forEach(function (r) {
        if (r.owner !== k) return;
        var cyc = cycleFor(anchor, r.spent_on);              // 有记录但可能没有期初行
        if (!seen[cyc.start]) pushCycle(cyc, memberView(k, cyc.end).rowsAsc);
      });
      if (!cycles.length) cycles = [v];                       // 尚无任何数据时，用当前账期占位
      cycles.sort(function (a, b) { return a.cycle.start < b.cycle.start ? -1 : 1; });

      return '<div class="card">' +
        '<div class="card-head"><h2 class="card-title">' + esc(v.member.name) + ' · 按周期支出</h2></div>' +
        cycleBarChartHtml(v.member, cycles) +
      '</div>';
    }).join('');

    var purposeTotals = {};
    PURPOSES.forEach(function (p) {
      purposeTotals[p.key] = views.reduce(function (s, v) { return s + (v.byPurpose[p.key] || 0); }, 0);
    });

    var purposeCard = '<div class="card"><div class="card-head"><h2 class="card-title">用途合计</h2>' +
      '<span class="card-note">合计 ' + money(purposeTotal) + '</span></div>' +
      '<div class="cat-grid">' + purposeCells + '</div>' +
      (purposeBars ? '<div class="bar-track">' + purposeBars + '</div>' : '') +
    '</div>';

    return '<div class="stack">' +
      hero +
      minis +
      purposeCard +
      barCards +
      '<div class="card"><div class="card-head"><h2 class="card-title">账期概览</h2></div>' +
        '<div class="kv-list">' + detailRows + '</div></div>' +
    '</div>';
  }

  /* -------- 整体渲染 -------- */
  function render() {
    var main = el('main');
    var sw = el('roleSwitch');

    sw.setAttribute('data-role', state.role);
    Array.prototype.forEach.call(sw.querySelectorAll('.role-tab'), function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-role') === state.role));
    });

    var accent = state.role === ROLE_ALL ? '#A468F5' : MEMBER_MAP[state.role].accent;
    var accentDeep = state.role === ROLE_ALL ? '#7C43E0' : MEMBER_MAP[state.role].accentDeep;
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-deep', accentDeep);

    if (state.loading) { main.innerHTML = skeleton(); return; }
    if (state.error) { main.innerHTML = errorBlock(state.error); return; }

    main.innerHTML = (state.role === ROLE_ALL) ? renderOverview() : renderMember(state.role);
    afterRender();
  }

  /** 渲染后调整：柱状图列较多时默认滚到最右（最新账期一侧） */
  function afterRender() {
    Array.prototype.forEach.call(document.querySelectorAll('.cycle-bars'), function (b) {
      if (b.scrollWidth > b.clientWidth + 1) b.scrollLeft = b.scrollWidth;
    });
  }

  function updateFooter() {
    var t = el('footerNote');
    if (!t) return;
    if (syncing) {
      t.textContent = '正在同步到 GitHub 仓库…';
    } else if (syncError) {
      t.textContent = '云端同步失败（数据已存本机，点刷新可重试）：' + (syncError.message || syncError);
    } else if (state.lastSync) {
      t.textContent = '已同步到 GitHub · 最近更新 ' +
        pad2(state.lastSync.getHours()) + ':' + pad2(state.lastSync.getMinutes()) +
        (storageWarning ? ' · 本机存储不可用，数据以云端为准' : '');
    } else if (!ghGetToken()) {
      t.textContent = '读取云端正常；记账后首次同步需配置密钥（页脚「同步密钥」）' +
        (storageWarning ? ' · 本机存储不可用，数据以云端为准' : '');
    } else {
      t.textContent = '数据保存在本机浏览器';
    }
  }

  /* ------------------------------------------------------------------
   * 导出 / 导入：用于手机和电脑之间手动同步账目
   * ------------------------------------------------------------------ */
  function exportData() {
    try {
      var payload = { version: 'github-pages', exported_at: new Date().toISOString(), ledger_cycles: state.cycles, ledger_records: state.records };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      var d = new Date();
      a.download = '账目导出-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('已导出到下载文件', 'ok');
    } catch (e) {
      toast('导出失败：' + (e.message || e), 'err');
    }
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var d = JSON.parse(String(reader.result));
        if (!d || !Array.isArray(d.ledger_records)) throw new Error('文件格式不对，请使用本应用导出的 JSON');
        if (!window.confirm('导入将覆盖本机当前全部账目（现有 ' + state.records.length + ' 条 → 导入 ' + d.ledger_records.length + ' 条），确定继续？')) return;
        state.cycles = (d.ledger_cycles || []).map(normalizeCycle);
        state.records = d.ledger_records.map(normalizeRecord);
        sortRecords();
        persist();
        queuePush('导入数据覆盖：共 ' + state.records.length + ' 条');
        toast('导入成功：共 ' + state.records.length + ' 条记录，正在上传到 GitHub', 'ok');
        boot();
      } catch (e) {
        toast('导入失败：' + (e.message || e), 'err');
      }
    };
    reader.onerror = function () { toast('读取文件失败', 'err'); };
    reader.readAsText(file, 'utf-8');
  }

  /* ------------------------------------------------------------------ *
   * 8. Toast
   * ------------------------------------------------------------------ */
  var toastTimer = null;
  function toast(msg, kind) {
    var t = el('toast');
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ------------------------------------------------------------------ *
   * 9. 弹层
   * ------------------------------------------------------------------ */
  var sheet = null;   // 当前弹层状态

  function closeSheet() {
    var ov = el('overlay');
    if (ov.hidden) return;
    ov.classList.add('closing');
    setTimeout(function () {
      ov.hidden = true;
      ov.classList.remove('closing');
      ov.innerHTML = '';
      sheet = null;
    }, 150);
  }

  function openOverlay(html) {
    var ov = el('overlay');
    ov.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' +
      '<div class="sheet-grip"></div>' + html + '</div>';
    ov.hidden = false;
    ov.classList.remove('closing');
  }

  /** 记账弹层 */
  function openRecordSheet(opts) {
    opts = opts || {};
    var rec = opts.record || null;
    var memberKey = opts.memberKey || state.role;
    if (memberKey === ROLE_ALL) memberKey = MEMBERS[0].key;

    var member = MEMBER_MAP[memberKey];
    var cyc = rec
      ? cycleFor(member.anchorDay, rec.spent_on)
      : cycleFor(member.anchorDay, todayIso());

    sheet = {
      mode: 'record',
      id: rec ? rec.id : null,
      memberKey: memberKey,
      kind: rec && isIncomeRow(rec) ? KIND_INCOME : KIND_EXPENSE,
      amount: rec ? String(rec.amount) : '',
      purpose: rec ? rec.purpose : 'personal',
      date: rec ? rec.spent_on : (function () {
        var t = todayIso();
        return (t >= cyc.start && t <= cyc.end) ? t : cyc.start;
      })(),
      note: rec ? rec.note : '',
      cycle: cyc,
      allowMemberSwitch: !!opts.allowMemberSwitch
    };
    renderSheet();
  }

  /** 弹层标题（区分支出 / 收入、新增 / 修改） */
  function sheetTitle(s) {
    if (!s) return '';
    var inc = s.kind === KIND_INCOME;
    return s.id ? (inc ? '修改收入' : '修改支出') : (inc ? '记一笔收入' : '记一笔支出');
  }

  /** 把弹层里已填写的内容同步回状态，切换「支出 / 收入」时不丢失输入 */
  function syncSheetInputs() {
    if (!sheet || sheet.mode !== 'record') return;
    var a = el('fAmount'); if (a) sheet.amount = a.value;
    var d = el('fDate'); if (d) sheet.date = d.value;
    var n = el('fNote'); if (n) sheet.note = n.value;
  }

  /** 期初资金弹层 */
  function openInitialSheet(memberKey) {
    var member = MEMBER_MAP[memberKey];
    var cyc = cycleFor(member.anchorDay, todayIso());
    var row = null;
    for (var i = 0; i < state.cycles.length; i++) {
      if (state.cycles[i].owner === memberKey && state.cycles[i].start_date === cyc.start) { row = state.cycles[i]; break; }
    }
    sheet = {
      mode: 'initial',
      memberKey: memberKey,
      amount: row ? String(row.initial_amount) : '',
      cycle: cyc
    };
    renderSheet();
  }

  function renderSheet() {
    if (!sheet) return;
    var member = MEMBER_MAP[sheet.memberKey];

    if (sheet.mode === 'initial') {
      openOverlay('' +
        '<div class="sheet-head">' +
          '<h2>记录初始资金 · ' + esc(member.name) + '</h2>' +
          '<button class="sheet-close" data-sheet="close" type="button" aria-label="关闭">✕</button>' +
        '</div>' +
        '<div class="field">' +
          '<label>本账期可支配资金</label>' +
          '<input class="input amount" id="fAmount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="' + esc(sheet.amount) + '">' +
        '</div>' +
        '<p style="margin:8px 0 0;font-size:12.5px;color:var(--text-3)">' +
          esc(member.name) + ' 的账期为 ' + esc(cycleLabel(sheet.cycle)) + '（每月 ' + member.anchorDay + ' 日起算）</p>' +
        '<div class="sheet-actions">' +
          '<button class="btn btn-block" data-sheet="close" type="button">取消</button>' +
          '<button class="btn btn-primary btn-block" data-sheet="save-initial" type="button">保存</button>' +
        '</div>');
    } else {
      var range = '（账期 ' + cycleLabel(sheet.cycle) + '）';
      var income = sheet.kind === KIND_INCOME;
      var memberPicker = sheet.allowMemberSwitch
        ? '<div class="field"><label>记账人</label><div class="purpose-picker" id="memberPicker">' +
            MEMBERS.map(function (m) {
              return '<button type="button" class="purpose-opt" data-member="' + m.key + '" aria-pressed="' +
                (m.key === sheet.memberKey ? 'true' : 'false') + '" style="--p-color:' + m.accent + '">' +
                '<span class="dot"></span><span class="p-name">' + esc(m.name) + '</span></button>';
            }).join('') + '</div></div>'
        : '';

      var kindSwitch = '<div class="kind-switch" id="kindSwitch">' +
          '<button type="button" data-kind="' + KIND_EXPENSE + '" aria-pressed="' + (income ? 'false' : 'true') + '">支出</button>' +
          '<button type="button" data-kind="' + KIND_INCOME + '" aria-pressed="' + (income ? 'true' : 'false') + '">收入</button>' +
        '</div>';

      // 收入不区分用途，仅支出需要选择
      var purposeField = income ? '' :
        '<div class="field">' +
          '<label>用途</label>' +
          '<div class="purpose-picker" id="purposePicker">' +
            PURPOSES.map(function (p) {
              return '<button type="button" class="purpose-opt" data-purpose="' + p.key + '" aria-pressed="' +
                (p.key === sheet.purpose ? 'true' : 'false') + '" style="--p-color:' + p.color + '">' +
                '<span class="dot"></span><span class="p-name">' + esc(p.name) + '</span></button>';
            }).join('') +
          '</div>' +
        '</div>';

      openOverlay('' +
        '<div class="sheet-head">' +
          '<h2>' + sheetTitle(sheet) + ' · ' + esc(member.name) + '</h2>' +
          '<button class="sheet-close" data-sheet="close" type="button" aria-label="关闭">✕</button>' +
        '</div>' +
        kindSwitch +
        memberPicker +
        '<div class="field">' +
          '<label>' + (income ? '收入金额' : '支出金额') + '</label>' +
          '<input class="input amount" id="fAmount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="' + esc(sheet.amount) + '">' +
        '</div>' +
        purposeField +
        '<div class="form-grid">' +
          '<div class="field"><label id="dateLabel">日期' + range + '</label>' +
            '<input class="input" id="fDate" type="date" value="' + esc(sheet.date) + '" min="' + sheet.cycle.start + '" max="' + sheet.cycle.end + '"></div>' +
        '</div>' +
        '<div class="field"><label>明细</label>' +
          '<input class="input" id="fNote" type="text" maxlength="60" placeholder="' +
            (income ? '例如：工资、红包、报销' : '例如：牛奶、鸡蛋、纸巾') + '" value="' + esc(sheet.note) + '"></div>' +
        '<div class="sheet-actions">' +
          '<button class="btn btn-block" data-sheet="close" type="button">取消</button>' +
          '<button class="btn btn-primary btn-block" data-sheet="save-record" type="button">保存</button>' +
        '</div>');
    }

    var amt = el('fAmount');
    if (amt) {
      setTimeout(function () {
        amt.focus();
        try { amt.setSelectionRange(amt.value.length, amt.value.length); } catch (e) {}
      }, 260);
    }
  }

  /* ------------------------------------------------------------------ *
   * 10. 交互处理
   * ------------------------------------------------------------------ */
  async function withBusy(btn, fn) {
    if (btn) btn.disabled = true;
    try { await fn(); }
    finally { if (btn) btn.disabled = false; }
  }

  async function refreshData(showToast) {
    // 「刷新」= 从 GitHub 拉取云端最新账目并合并到本地
    await pullRemote(showToast);
  }

  function onSaveRecord(btn) {
    if (!sheet) return;
    var income = sheet.kind === KIND_INCOME;
    var word = income ? '收入' : '支出';
    var amountRaw = (el('fAmount').value || '').trim();
    var amount = Number(amountRaw);
    var dateVal = el('fDate').value;
    var noteVal = (el('fNote').value || '').trim();

    sheet.amount = amountRaw;
    sheet.note = noteVal;

    if (!amountRaw || !isFinite(amount) || amount <= 0) { toast('请输入大于 0 的' + word + '金额', 'err'); return; }
    if (!dateVal) { toast('请选择' + word + '日期', 'err'); return; }
    if (dateVal < sheet.cycle.start || dateVal > sheet.cycle.end) {
      toast('日期需在账期 ' + cycleLabel(sheet.cycle) + ' 之内', 'err');
      return;
    }
    if (!noteVal) {
      toast('请填写这笔' + word + '的明细', 'err');
      var noteInput = el('fNote');
      if (noteInput) noteInput.focus();
      return;
    }

    var payload = {
      owner: sheet.memberKey,
      amount: Math.round(amount * 100) / 100,
      purpose: income ? INCOME_PURPOSE : sheet.purpose,
      kind: income ? KIND_INCOME : KIND_EXPENSE,
      spent_on: dateVal,
      note: noteVal || null
    };
    var id = sheet.id;

    withBusy(btn, async function () {
      try {
        if (id) { await updateRecord(id, payload); toast(income ? '收入已更新' : '已更新并重新计算日均', 'ok'); }
        else {
          await insertRecord(payload);
          toast(income ? '已记录收入，余额已更新' : '已记账，日均可用已更新', 'ok');
        }
        closeSheet();
        await loadData();
        state.error = null;
        render();
        updateFooter();
      } catch (e) {
        toast(friendlyError(e), 'err');
      }
    });
  }

  function onSaveInitial(btn) {
    if (!sheet) return;
    var amountRaw = (el('fAmount').value || '').trim();
    var amount = Number(amountRaw);
    sheet.amount = amountRaw;
    if (!amountRaw || !isFinite(amount) || amount < 0) { toast('请输入有效的初始资金金额', 'err'); return; }

    var owner = sheet.memberKey;
    var cyc = sheet.cycle;

    withBusy(btn, async function () {
      try {
        await saveCycle(owner, cyc, Math.round(amount * 100) / 100);
        toast('初始资金已保存', 'ok');
        closeSheet();
        await loadData();
        state.error = null;
        render();
        updateFooter();
      } catch (e) {
        toast(friendlyError(e), 'err');
      }
    });
  }

  function onDeleteRecord(id) {
    var rec = null;
    for (var i = 0; i < state.records.length; i++) { if (state.records[i].id === id) { rec = state.records[i]; break; } }
    var label = rec
      ? (MEMBER_MAP[rec.owner] ? MEMBER_MAP[rec.owner].name + ' · ' : '') +
        (isIncomeRow(rec) ? '收入' : (PURPOSE_MAP[rec.purpose] ? PURPOSE_MAP[rec.purpose].name : '')) +
        ' ' + money(rec.amount) + '（' + fmtDateFull(rec.spent_on) + '）' +
        (rec.note ? ' · ' + rec.note : '')
      : '这条记录';
    if (!window.confirm('确定删除 ' + label + ' 吗？\n删除后余额与日均可用花费会重新计算，此操作不可撤销。')) return;

    (async function () {
      try {
        await removeRecord(id);
        toast('已删除', 'ok');
        await loadData();
        render();
        updateFooter();
      } catch (e) {
        toast(friendlyError(e), 'err');
      }
    })();
  }

  function bindEvents() {
    el('roleSwitch').addEventListener('click', function (e) {
      var btn = e.target.closest('.role-tab');
      if (!btn) return;
      var role = btn.getAttribute('data-role');
      if (role === state.role) return;
      state.role = role;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    el('refreshBtn').addEventListener('click', function () {
      var b = el('refreshBtn');
      b.classList.add('spinning');
      refreshData(true).finally(function () {
        setTimeout(function () { b.classList.remove('spinning'); }, 350);
      });
    });

    el('exportBtn').addEventListener('click', exportData);
    el('importBtn').addEventListener('click', function () { el('importFile').click(); });
    el('importFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importData(f);
      e.target.value = '';
    });
    el('syncBtn').addEventListener('click', function () {
      var t = window.prompt(
        '配置 GitHub 同步密钥（github_pat_ 开头）。\n' +
        '每台设备配置一次即可，只保存在本机浏览器。清空则不再同步。', ghGetToken() || '');
      if (t === null) return;                          // 取消 = 不做任何改动
      ghSetToken(t);
      if (!ghGetToken()) {
        syncError = new Error('密钥已清空：账目暂时只保存在本机');
        updateFooter();
        toast('已清除同步密钥', 'ok');
        return;
      }
      syncError = null;
      remoteSha = null;
      updateFooter();
      refreshData(true);
    });

    el('main').addEventListener('click', function (e) {
      var t = e.target.closest('[data-action]');
      if (!t) return;
      var action = t.getAttribute('data-action');

      if (action === 'reload') { boot(); return; }
      if (action === 'range') {
        var mode = t.getAttribute('data-mode');
        if (mode === state.rangeMode) return;
        state.rangeMode = mode;
        render();
        return;
      }
      if (action === 'chart-year') {
        var y = Number(t.getAttribute('data-year'));
        if (y === state.chartYear) return;
        state.chartYear = y;
        render();
        return;
      }
      if (action === 'set-initial') { openInitialSheet(t.getAttribute('data-member')); return; }
      if (action === 'new-record') {
        var mk = t.getAttribute('data-member');
        openRecordSheet({ memberKey: mk === 'all' ? null : mk, allowMemberSwitch: mk === 'all' });
        return;
      }
      if (action === 'edit-record') {
        var id = Number(t.getAttribute('data-id'));
        var rec = null;
        for (var i = 0; i < state.records.length; i++) { if (state.records[i].id === id) { rec = state.records[i]; break; } }
        if (!rec) { toast('未找到该记录', 'err'); return; }
        openRecordSheet({ record: rec, memberKey: rec.owner });
        return;
      }
      if (action === 'del-record') { onDeleteRecord(Number(t.getAttribute('data-id'))); return; }
    });

    el('overlay').addEventListener('click', function (e) {
      if (e.target === el('overlay')) { closeSheet(); return; }

      var purposeBtn = e.target.closest('#purposePicker .purpose-opt');
      if (purposeBtn && sheet && sheet.mode === 'record') {
        sheet.purpose = purposeBtn.getAttribute('data-purpose');
        Array.prototype.forEach.call(el('purposePicker').querySelectorAll('.purpose-opt'), function (b) {
          b.setAttribute('aria-pressed', String(b.getAttribute('data-purpose') === sheet.purpose));
        });
        return;
      }

      var kindBtn = e.target.closest('#kindSwitch [data-kind]');
      if (kindBtn && sheet && sheet.mode === 'record') {
        var nextKind = kindBtn.getAttribute('data-kind');
        if (nextKind === sheet.kind) return;
        syncSheetInputs();                                   // 切换前保存已填内容
        sheet.kind = nextKind;
        if (nextKind === KIND_EXPENSE && sheet.purpose === INCOME_PURPOSE) sheet.purpose = 'personal';
        renderSheet();
        return;
      }

      var memberBtn = e.target.closest('#memberPicker .purpose-opt');
      if (memberBtn && sheet && sheet.mode === 'record') {
        sheet.memberKey = memberBtn.getAttribute('data-member');
        Array.prototype.forEach.call(el('memberPicker').querySelectorAll('.purpose-opt'), function (b) {
          b.setAttribute('aria-pressed', String(b.getAttribute('data-member') === sheet.memberKey));
        });

        // 切换记账人后，账期与可选日期区间同步刷新
        var nm = MEMBER_MAP[sheet.memberKey];
        var nc = cycleFor(nm.anchorDay, sheet.date);
        sheet.cycle = nc;
        var dateEl = el('fDate');
        if (dateEl) {
          dateEl.min = nc.start;
          dateEl.max = nc.end;
          var t = todayIso();
          if (dateEl.value < nc.start || dateEl.value > nc.end) {
            dateEl.value = (t >= nc.start && t <= nc.end) ? t : nc.start;
          }
          sheet.date = dateEl.value;
        }
        var dl = el('dateLabel');
        if (dl) dl.textContent = '日期（账期 ' + cycleLabel(nc) + '）';
        var h2 = document.querySelector('#overlay .sheet-head h2');
        if (h2) h2.textContent = sheetTitle(sheet) + ' · ' + nm.name;
        return;
      }

      var act = e.target.closest('[data-sheet]');
      if (!act) return;
      var cmd = act.getAttribute('data-sheet');
      if (cmd === 'close') closeSheet();
      if (cmd === 'save-record') onSaveRecord(act);
      if (cmd === 'save-initial') onSaveInitial(act);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!el('overlay').hidden) { closeSheet(); return; }
    });
  }

  /* ------------------------------------------------------------------ *
   * 11. 启动
   * ------------------------------------------------------------------ */
  async function boot() {
    state.loading = true;
    state.error = null;
    render();

    // 1) 先加载本地缓存（秒开）
    try {
      await withTimeout(loadData(), 20000, 'TIMEOUT');
      state.loading = false;
      state.error = null;
    } catch (e) {
      state.loading = false;
      state.error = friendlyError(e);
    }
    render();
    updateFooter();

    // 2) 后台从 GitHub 拉取云端最新数据并合并
    if (!state.error) {
      var remote = await pullRemote(false);
      // 3) 云端确认还没有数据文件 → 把本地数据初始化上传（网络失败则不动作）
      if (remote === null) queuePush('初始化账本数据');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindEvents(); boot(); });
  } else {
    bindEvents();
    boot();
  }
})();
