/* 客数予測エンジン — スプシ「時間帯別客数予測 v2」TEMPLATE(2026-07-18版) の数式を忠実に移植。
 * 参照: store/marketing/客数/スプシ退避/時間帯別客数予測v2/formulas/TEMPLATE.csv
 * 全て 18時間帯 (6:00〜23:00) の配列で扱う。
 */
"use strict";

const EPOCH_UTC = Date.UTC(1899, 11, 30);
const N = 18;

function isoToSerial(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH_UTC) / 86400000);
}
function serialToIso(s) {
  const d = new Date(EPOCH_UTC + s * 86400000);
  return d.toISOString().slice(0, 10);
}
const WD = ["日", "月", "火", "水", "木", "金", "土"];
function wdOf(iso) { const d = new Date(iso + "T00:00:00Z"); return WD[d.getUTCDay()]; }

const EPS = 1e-9;
const ceil1 = (x) => Math.ceil(x - EPS);              // Excel ROUNDUP(x)（正数前提）
const ceilHalf = (x) => Math.ceil(x * 2 - EPS) / 2;   // ROUNDUP(x*2)/2 = 0.5刻み切上げ
const roundHalf = (x) => Math.round(x * 2) / 2;       // ROUND(x*2)/2

/** 負担係数の畳み込み: burden[c] = Σ LE[c-2..c+1] × win[-2H,-1H,0H,+1H]（範囲外=0） */
function convolve(le, win) {
  const out = new Array(N).fill(0);
  for (let c = 0; c < N; c++) {
    const g = (i) => (i >= 0 && i < N ? le[i] : 0);
    out[c] = g(c - 2) * win[0] + g(c - 1) * win[1] + g(c) * win[2] + g(c + 1) * win[3];
  }
  return out;
}

/**
 * 1日分を計算する。
 * @param data  data.json の中身
 * @param params params.json の中身 {byDate: {"YYYY-MM-DD": {weather,event,fixedF,fixedK,mgt,op,crewWage,regWage}}}
 * @param iso   "YYYY-MM-DD"
 */
function computeDay(data, params, iso) {
  const s = String(isoToSerial(iso));
  const tab = (name) => (data.tabs[name] && data.tabs[name][s]) || new Array(N).fill(0);
  const ov = (params.byDate && params.byDate[iso]) || {};
  const pick = (key, fallback) => (Array.isArray(ov[key]) ? ov[key].map(Number) : fallback.slice());
  // 設定レイヤ: 負担係数(global.burden) と MGT H 月一括(monthly[YYYY-MM].mgt)
  const burden = (params.global && params.global.burden) || data.burden;
  const monthly = (params.monthly && params.monthly[iso.slice(0, 7)]) || {};
  const mgtDefault = Array.isArray(monthly.mgt) ? monthly.mgt.map(Number) : data.defaults.mgt;

  // ACT: 過去日はらくしふ確定シフトの実績労働時間（crew=クルー, reg=正社員）
  const act = (data.act && data.act[s]) || null;

  const leBase = tab("LE");
  const by = tab("BY");
  const budget = Number(s) >= data.budget_start_serial ? tab("BUDGET") : new Array(N).fill(null);
  const weather = pick("weather", tab("WEATHER"));
  const event = pick("event", tab("EVENT"));
  const fixedF = pick("fixedF", data.defaults.fixedF);
  const fixedK = pick("fixedK", data.defaults.fixedK);
  const mgt = pick("mgt", mgtDefault);
  const op = pick("op", act ? act.reg : data.defaults.op);  // REGULAR OP（ACT日はシフトの社員時間）
  const tr = pick("tr", new Array(N).fill(0));  // トレーニング時間（アプリ専用・シート非対応）
  const crewWage = pick("crewWage", data.defaults.crewWage);
  const regWage = pick("regWage", data.defaults.regWage);
  const ac = tab("AC");

  // r15: LE = LEベース×(1+天候)×(1+イベント)
  const le = leBase.map((v, i) => v * (1 + weather[i]) * (1 + event[i]));

  // r17-19: 負担係数
  const bF = convolve(le, burden.F.win);
  const bK = convolve(le, burden.K.win);
  const bAll = bF.map((v, i) => v + bK[i]);

  // r21-23: CALC REQ = ROUNDUP(負担)/人時負担値
  const unitF = burden.F.unit, unitK = burden.K.unit, unitAvg = (unitF + unitK) / 2;
  const calcF = bF.map((v) => ceil1(v) / unitF);
  const calcK = bK.map((v) => ceil1(v) / unitK);
  const calcAll = bAll.map((v) => ceil1(v) / unitAvg);

  // r25-27: REQ（0.5刻み・最低1）／FK=不足分
  const reqF = calcF.map((v) => (roundHalf(v) < 1 ? 1 : ceilHalf(v)));
  const reqK = calcK.map((v) => (roundHalf(v) < 1 ? 1 : ceilHalf(v)));
  const reqFK = calcAll.map((v, i) => {
    const thr = (reqF[i] + reqK[i]) * 0.8;
    return v > thr ? ceilHalf(v - thr) : 0;
  });
  const reqSum = reqF.map((v, i) => v + reqK[i] + reqFK[i]);

  // r34-37: REPLAN（固定作業を足して0.5刻み切上げ）
  const repF = reqF.map((v, i) => ceilHalf(v + fixedF[i]));
  const repK = reqK.map((v, i) => ceilHalf(v + fixedK[i]));
  const repFK = reqFK.slice();
  const repSum = repF.map((v, i) => v + repK[i] + repFK[i]);

  // r39-41: 整数REPLAN
  const intF = repF.map(ceil1);
  const intK = repK.map(ceil1);
  const intFK = repSum.map((v, i) => (v > intF[i] + intK[i] ? ceil1(v - intF[i] - intK[i]) : 0));

  // r46: recal CREW LABOR H = REPLAN(SUM) − REGULAR OP（ACT日はシフトのクルー実績時間）
  // ACT日の意味論: 実績総H(crew+reg)が全体。MGT H・TR H は後から分類として入力し、
  //   OP H(オペ人時) = 実績総H − MGT − TR。コストは実績時間×時給で確定（tr/mgtで二重計上しない）
  const recalCrew = act ? act.crew.slice() : repSum.map((v, i) => v - op[i]);

  // r49-58: 売上・人件費（TRはクルー時給でクルー人件費に加算。tr=0ならシートと完全一致）
  // ACT日: TR/MGTは実績時間の内訳分類なのでコスト・総Hに足さない
  const sales = ac.map((v, i) => (v * le[i]) / 1000);                 // 千円
  const crewYen = act ? recalCrew.map((v, i) => v * crewWage[i])
                      : recalCrew.map((v, i) => (v + tr[i]) * crewWage[i]);
  const regYen = act ? regWage.map((v, i) => v * op[i])
                     : regWage.map((v, i) => v * (mgt[i] + op[i]));
  const totalH = act ? recalCrew.map((v, i) => v + op[i])
                     : mgt.map((v, i) => v + op[i] + recalCrew[i] + tr[i]);
  const totalYen = crewYen.map((v, i) => v + regYen[i]);

  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const salesSum = sum(sales);
  const totalYenSum = sum(totalYen);
  const laborPct = salesSum > 0 ? totalYenSum / salesSum / 1000 : 0;  // AA58相当
  const sbp = salesSum * 0.55 - totalYenSum / 1000;                   // 千円

  return {
    iso, serial: Number(s), weekday: wdOf(iso),
    act: !!act,
    rows: {
      by, budget, leBase, weather, event, le,
      bF, bK, bAll, calcF, calcK, calcAll,
      reqF, reqK, reqFK, reqSum,
      fixedF, fixedK, repF, repK, repFK, repSum,
      intF, intK, intFK,
      mgt, op, tr, recalCrew, ac, sales,
      crewWage, crewYen, regWage, regYen, totalH, totalYen,
    },
    summary: {
      leSum: sum(le), bySum: sum(by), replanH: sum(repSum),
      salesSum, totalH: sum(totalH), totalYenSum, laborPct, sbp,
      crewH: sum(recalCrew), mgtH: sum(mgt), opH: sum(op), trH: sum(tr),
      // OP H(オペ人時)の表示値: ACT日=実績総H−MGT−TR / 予測日=REPLAN計
      opHDisp: act ? sum(totalH) - sum(mgt) - sum(tr) : sum(repSum),
    },
  };
}

if (typeof module !== "undefined") module.exports = { computeDay, isoToSerial, serialToIso };
// 拡張のcontent script用: 分離ワールドのグローバルに公開
if (typeof globalThis !== "undefined") globalThis.__leEngine = { computeDay, isoToSerial, serialToIso };
