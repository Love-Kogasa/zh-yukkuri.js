/**
 * 音高(F0)轮廓公式 —— 纯函数,基于共享公式表;被第三级(分词流水线)
 * 和展开器的即时音高兜底共同使用。
 */
import type { PitchFormula, Voice } from "../core/types.js";

/**
 * 重音感知的核心音高公式(套 voice 包装之前的内层值)。
 *
 * 计算过程分四种情形:
 *
 *  - 音节数 N < 2:无重音 → 返回 null(调用方用锚点/基准值兜底);
 *    有重音 → trunc0(coef × 0x1400 / 1024)(即 coef × 5)。
 *
 *  - 复合词拆分(N > 6 且重音 > 3):长词像复合词一样分段计算——
 *    位置在重音之后 → 后段 {N: N-acc+1, acc: 1}(把重音折算到段内);
 *    位置在重音之前 → 前段 {N: acc-1, acc: 0, 类型 3},且后段重音记 1。
 *
 *  - 模式搜索:先把 N 夹到 [1,6]、重音夹到 [0,5]、类型夹到 [0,2],
 *    **夹完再比较** N==重音 → 重音清零(平板型);用夹后的值查
 *    模式表得到行号。
 *
 *  - 取值:N < 7 直接查行;N ≥ 7 且重音 < 6 走"查表 + 中段线性插值 +
 *    尾段对齐"的三段式;重音 ≥ 6 的四段曲线经拆分路径不可达
 *    (拆分先把重音降到 4 以下),保留只为完整性。
 *
 *  最后按系数缩放:trunc0(表值 × coef / 1024)。
 */
export function f0Inner46e0(
  formula: PitchFormula,
  pos: number,
  N: number,
  acc: number,
  type: number,
  coef: number,
  nextAcc: number,
): number | null {
  if (N < 2) {
    if (acc === 0) return null;
    return Math.trunc((coef * 0x1400) / 1024);
  }
  if (N > 6 && acc > 3) {
    if (acc <= pos) return f0Inner46e0(formula, pos - acc + 1, N - acc + 1, 1, type, coef, nextAcc);
    return f0Inner46e0(formula, pos, acc - 1, 0, 3, coef, 1);
  }
  // 边界类型 → 行组与类型列的映射:、 , → 组1列0;。 → 组1列1;？ → 组1列2;
  // 其余(含 3/4/5)→ 组0,类型列取"下一个分词的重音"
  let type2 = nextAcc;
  let group = 0;
  if (type === 6 || type === 7) {
    group = 1;
    type2 = 0;
  } else if (type === 8) {
    group = 1;
    type2 = 1;
  } else if (type === 9) {
    group = 1;
    type2 = 2;
  }
  const n6 = Math.min(Math.max(N, 1), 6);
  let accC = Math.min(Math.max(acc, 0), 5);
  if (n6 === accC) accC = 0;
  const typeC = Math.min(Math.max(type2, 0), 2);
  let pattern = -1;
  for (let i = 0; i < 60; i++) {
    if (
      formula.t15ff4[i * 4 + 1] === n6 &&
      formula.t15ff4[i * 4 + 2] === accC &&
      formula.t15ff4[i * 4 + 3] === typeC
    ) {
      pattern = i;
      break;
    }
  }
  if (pattern < 0) return 0; // 合法表下不可达
  const row = pattern + group * 60;
  const T = (col: number) => formula.t161d4[row * 10 + col];
  let value: number;
  if (N < 7) {
    value = T(pos);
  } else if (acc < 6) {
    // q = 本行的"插值起点"列(存在行前一字里)
    const q = formula.t161d4[row * 10 - 1];
    if (pos <= q) value = T(pos);
    else if (pos <= q + N - 6)
      value = Math.trunc(((T(q + 1) - T(q)) * (pos - q)) / (N - 5)) + T(q);
    else value = T(6 - N + pos);
  } else {
    // 重音 ≥ 6 的四段曲线(经拆分路径不可达,保真保留)
    if (pos < 4) value = T(pos);
    else if (pos < acc - 1)
      value = Math.trunc(((T(6) - T(5)) * (pos - 3)) / (acc - 4)) + T(5);
    else if (pos === acc - 1) value = T(6);
    else if (pos + 1 < N)
      value = Math.trunc(((T(7) - T(6)) * (pos - acc)) / (N - acc)) + T(6);
    else value = T(6 - N + pos);
  }
  return Math.trunc((((value << 16) >> 16) * coef) / 1024);
}

/**
 * 分词内某个音节的 f0:在内层值外面套 voice 包装 ——
 * A 族加基准偏移;B 族做"i16 截断 → 乘系数加偏移"的换算。
 */
export function f0ByFormula(
  formula: PitchFormula,
  pos: number,
  moraCount: number,
  coef: number = formula.coef,
  tokenType: number = 8,
  accent: number = 0,
  nextAccent: number = 0,
): number {
  const inner = f0Inner46e0(formula, pos, moraCount, accent, tokenType, coef, nextAccent);
  if (inner === null) {
    // 无重音短路:B 族包装仍然要加自己的偏移(imd1 的 N=1 f0 恰等于其偏移)
    return formula.familyB ? formula.familyB.offset : formula.base;
  }
  if (!formula.familyB) return inner + formula.base;
  // B 族换算:i16 截断后 trunc0(v × mult × 0xc907da5 / 2^35) + offset。
  // 分子不超过 2^53,浮点运算精确。
  const truncated = (inner << 16) >> 16;
  const scaled = Math.floor((truncated * formula.familyB.mult * 0xc907da5) / 0x800000000);
  return (scaled < 0 ? scaled + 1 : scaled) + formula.familyB.offset;
}

/** 分词第 pos 个音节(共 moraCount 个)的脉冲周期(p2)。 */
export function moraPulsePeriod(
  voice: Voice,
  pos: number,
  moraCount: number,
  coef: number,
  tokenType: number,
  accent: number,
): number {
  const f0 = f0ByFormula(voice.constants.pitchFormula, pos, moraCount, coef, tokenType, accent);
  return f0 !== 0
    ? Math.floor(voice.constants.f0Numerator / f0)
    : voice.constants.pitchAnchor;
}
