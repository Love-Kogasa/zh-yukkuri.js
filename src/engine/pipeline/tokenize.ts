/**
 * 第三级 —— 短语内的分词流水线:
 *   切分(accumulate 分词)→ 系数链 → f0 填充与词尾外推
 *   → `+` 号融合 → 每音节的脉冲周期。
 */
import type { PhraseToken, Voice } from "../core/types.js";
import { dividePow2Rounded } from "../core/types.js";
import { f0ByFormula } from "./pitch.js";

/** 标点停顿权重(原始样本单位):, → 666、、 → 2000、。 → 4000;？不加停顿。 */
export const PUNCT_PAUSE: Record<number, number> = { 6: 666, 7: 2000, 8: 4000 };

/**
 * 短语系数链乘法表(8 个 voice 逐字节相同)。
 * 每个分词的 F0 系数 = MULT[上一短语收尾类型 × 7 + 本分词类型],
 * 再以 0x400 为基准右移 10 位得到 coef。
 */
export const PHRASE_COEF_MULT: number[] = [
  1977, 0, 0, 0, 6, 4, 2438,
  5120, 6502, 6464, 3769, 435, 0, 0,
  6, 4, 3200, 5120, 6099, 6035, 5766,
  1318, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 1065, 1065, 945, 902,
  902, 766, 1098, 1345, 1345, 1198, 1239,
  1239, 1152, 1098, 1374, 1374, 1207, 1197,
  1197, 1093, 1098, 1374, 1374, 1207, 1197,
  1197, 1093, 1098, 1665, 1665, 1510, 1569,
  1569, 1312, 1098, 1065, 1065, 945, 902,
  902, 766, 1098,
];

/** id 6..9(, 、 。 ？)是短语边界标记。 */
export function isBoundaryId(id: number): boolean {
  return id >= 6 && id <= 9;
}

/**
 * 把一个短语的 id 流切成分词序列:
 *   - 假名追加到当前打开的分词;
 *   - `+`/`/`/`;`(3/4/5)关闭当前分词(没有打开的分词时直接丢弃);
 *   - 短语尾部的边界段由调用方消费,6..9 不会出现在这里,
 *     仍未关闭的分词以 `closingId` 为类型(序列耗尽时默认 8);
 *   - `&`(2)被整体丢弃,不改变任何分词状态。
 *
 * `'`(1)在有打开的分词时把重音记在当前音节数上;**没有**打开的
 * 分词时会开一个空分词(原版的分词分配原语不检查 id 就分配)。
 * 空分词不含音节,只在系数链上占一步、并参与"末分词类型"的判定
 * —— 它默认类型 8 会带释放尾,而 `+`/`/`/`;` 关闭的末分词不带,
 * 所以 `あい/'` 比无分词读法多出一段尾音。
 */
export function tokenizePhrase(phrase: number[], closingId: number): PhraseToken[] {
  const tokens: PhraseToken[] = [];
  let open: PhraseToken | null = null;
  const newToken = (): PhraseToken => ({
    N: 0, acc: 0, type: 8, coef: 0x400, ids: [], f0: [], baseMask: [],
  });
  for (const id of phrase) {
    if (id === 2) continue; // `&`:完全不改变分词状态
    if (id === 1) {
      if (open === null) open = newToken();
      open.acc = open.N;
      continue;
    }
    if (id < 10) {
      // `+`/`/`/`;` 关闭当前分词;没有打开的分词则丢弃
      if (open !== null) {
        open.type = id;
        tokens.push(open);
        open = null;
      }
      continue;
    }
    if (open === null) open = newToken();
    open.ids.push(id);
    open.f0.push(0);
    open.N++;
  }
  if (open !== null) {
    open.type = closingId;
    tokens.push(open);
  }
  return tokens;
}

/**
 * 从下标 i 起第一个类型不是 `+`(3)的分词类型 —— 即当前分词查
 * 系数表时用的"列"。(`+` 分词不定义列。)
 */
function nextNonPlusType(tokens: PhraseToken[], i: number): number {
  for (let k = i; k < tokens.length; k++) {
    if (tokens[k].type !== 3) return tokens[k].type;
  }
  return 8;
}

/**
 * 第一遍:分词系数链。首个分词的行是上一短语的收尾类型,后续分词
 * 用前一个分词的类型。两种"继承"不查表:
 *   - 前驱是 `+`(3):直接沿用前一个乘数;
 *   - 前驱是 `/`(4)且无重音、当前分词重音为 1:同样沿用。
 * 在"无重音的 `/`"之后查表得到的乘数有下限 trunc(前乘数 × 8/10)。
 * 最后 coef = trunc0(0x400 × mult / 1024)。
 */
function applyCoefChain(tokens: PhraseToken[], prevPhraseType: number): void {
  let prev: PhraseToken | null = null;
  let prevMult = 0x400;
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i];
    let mult: number;
    if (
      prev !== null &&
      (prev.type === 3 || (prev.type === 4 && prev.acc === 0 && cur.acc === 1))
    ) {
      mult = prevMult; // 继承前一个乘数,且不受 `/` 下限约束
    } else {
      const row = prev === null ? prevPhraseType : prev.type;
      mult = PHRASE_COEF_MULT[row * 7 + nextNonPlusType(tokens, i)];
      if (prev !== null && prev.type === 4 && prev.acc === 0) {
        const floor = Math.trunc((prevMult * 8) / 10);
        if (mult < floor) mult = floor;
      }
    }
    cur.coef = dividePow2Rounded(cur.coef * mult, 10);
    prev = cur;
    prevMult = mult;
  }
}

/**
 * 第二遍:f0 填充与词尾外推。
 * 先把每个仍是零的 f0 槽位按公式填上(下一分词的重音参与类型列
 * 查找);再把"词尾外推值"(位置 = N,越过最后一个音节)写进下一
 * 分词的首槽——除非被阻止:当前分词是边界类型 / 后继是重音 1 的
 * 双音节分词 / 当前是 `;` 且后继重音 1 / 首槽已被填。
 */
function fillTokenF0(tokens: PhraseToken[], voice: Voice): void {
  const formula = voice.constants.pitchFormula;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1] ?? null;
    for (let pos = 0; pos < t.N; pos++) {
      if (t.f0[pos] === 0) {
        t.f0[pos] = f0ByFormula(formula, pos, t.N, t.coef, t.type, t.acc, next ? next.acc : 0);
        // N==1 且无重音的填充走"兜底基准值"路径,标记之,
        // 后面换算周期时才能用单音节特例值(如 m2 的 687)
        if (t.N === 1 && t.acc === 0) t.baseMask[pos] = true;
      }
    }
    if (
      !isBoundaryId(t.type) &&
      next !== null &&
      !(next.N === 2 && next.acc === 1) &&
      !(t.type === 5 && next.acc === 1) &&
      next.f0[0] === 0
    ) {
      next.f0[0] = f0ByFormula(formula, t.N, t.N, t.coef, t.type, t.acc, next.acc);
    }
  }
}

/**
 * `+` 号(类型 3)融合:把 t1+t2 视作一个临时"融合分词"计算整组
 * 公式 f0,再逐槽平均回写进 t1/t2/t3 —— **融合分词本身不进队列**
 * (原版把它追加到队列末尾之后又把末指针拨回,等于丢弃)。
 * 每次融合后扫描从 t2 重启(游标回拨),连续的 `+` 会两两融合。
 */
function fusePlusTokens(tokens: PhraseToken[], voice: Voice): void {
  const formula = voice.constants.pitchFormula;
  for (let i = 0; i + 1 < tokens.length; i++) {
    const t1 = tokens[i];
    if (t1.type !== 3) continue;
    const t2 = tokens[i + 1];
    const t3 = tokens[i + 2] ?? null;
    const fused: PhraseToken = {
      N: t1.N + t2.N,
      acc: t1.acc !== 0 ? t1.acc : t2.acc === 0 ? 0 : (t1.N + t2.acc) & 0xff,
      type: t2.type,
      coef: t1.coef,
      ids: [],
      f0: [],
      baseMask: [],
    };
    fused.f0[0] = t1.f0[0];
    // t1.N == 1 时 f0[1] 越界读——读到的是紧邻的 t2 的"重音|类型"字节
    // (分词在内存里连续),照原样复刻
    fused.f0[1] = t1.N >= 2 ? t1.f0[1] : (t2.acc | (t2.type << 8)) & 0xffff;
    for (let pos = 2; pos < fused.N; pos++) {
      fused.f0[pos] = f0ByFormula(
        formula, pos, fused.N, fused.coef, fused.type, fused.acc, t3 ? t3.acc : 0,
      );
    }
    let wordEnd = 0;
    if (!isBoundaryId(fused.type) && t3 !== null && !(t3.N === 2 && t3.acc === 1)) {
      wordEnd = f0ByFormula(formula, fused.N, fused.N, fused.coef, fused.type, fused.acc, t3.acc);
    }
    // 融合值与 t1 原值平均(t1 覆盖 [2, N) 段)
    for (let pos = 2; pos < t1.N; pos++) {
      t1.f0[pos] = Math.floor((fused.f0[pos] + t1.f0[pos]) / 2);
    }
    // 尾部对齐进 t2(t2 的第 j 槽对应融合的第 start+j 槽)
    const start = Math.max(2, t1.N);
    for (let pos = start; pos < fused.N; pos++) {
      const j = pos - start;
      t2.f0[j] = Math.floor((t2.f0[j] + fused.f0[pos]) / 2);
    }
    // 词尾值对折进 t3 的首槽
    if (wordEnd !== 0 && t3 !== null) {
      t3.f0[0] = Math.floor((wordEnd + t3.f0[0]) / 2);
    }
  }
}

/** 分词流水线之后的每音节脉冲周期。 */
export interface PhrasePlan {
  tokens: PhraseToken[];
  pitches: number[];
}

/**
 * 完整的第三级输出:带 f0 的分词 + 每音节脉冲周期。
 * 单音节无重音的槽位保留"单音节周期特例"(m2 是 687,与
 * floor(分子/基准) 的 686 差 1,不能从公式反推)。
 */
export function planPhrase(
  phrase: number[],
  voice: Voice,
  prevPhraseType: number,
  closingId: number,
): PhrasePlan {
  const tokens = tokenizePhrase(phrase, closingId);
  applyCoefChain(tokens, prevPhraseType);
  fillTokenF0(tokens, voice);
  fusePlusTokens(tokens, voice);
  const { f0Numerator, pitchAnchor, singleMoraPitchOverride } = voice.constants;
  const pitches: number[] = [];
  for (const t of tokens) {
    for (let pos = 0; pos < t.N; pos++) {
      if (t.baseMask[pos]) {
        pitches.push(singleMoraPitchOverride ?? pitchAnchor);
      } else {
        const f0 = t.f0[pos];
        // 除数是 f0 槽按**无符号 16 位**读取的值(不是有符号数!)——
        // B 族换算可能产出负 f0(如 `&` 型短语后的系数行),负值
        // -31274 按无符号 34262 参与除法得 119。商再回绕到 16 位,
        // 所以很小的 |f0| 会把标志位泄进结果(f0=2 → 0x4000,恰好是
        // 50 样本帧的标志)。f0 为 0 时直接得 0(不走除法)。
        if (f0 !== 0) pitches.push(Math.trunc(f0Numerator / (f0 & 0xffff)) & 0xffff);
        else pitches.push(0);
      }
    }
  }
  return { tokens, pitches };
}
