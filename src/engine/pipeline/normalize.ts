/**
 * 第二级 —— 解析后的 id 规范化(两个按固定顺序执行的改写遍)。
 *
 * 背景:假名 id 里有一批"上下文变体"段(170–195),它们不直接进展开器,
 * 而是在这里按前后文决定最终形态:词首的 ぎ/ぐ/げ/ご/ぴ 用哪个变体、
 * 什么时候触发大写元音体(き→kI 这类清化辅音体),都在 id 层面拍板。
 * (在音素名层面猜这些形态会有盲区,必须按 id 逐条改写。)
 */

/**
 * 会触发"下一个假名用大写元音体"的 id 集合 —— 即辅音属于清阻塞音
 * (k/t/p/c/h 系)的音节。等价于"名字首字符 ∈ {k,t,p,c,h}"再加上
 * 特例 id 135("Lu"),去掉 101–104("Ha/Hu/He/Ho",确不触发)。
 */
const ONSET_TRIGGER_IDS = new Set([
  15, 16, 17, 18, 19, // か行
  25, 26, 27, 28, 29, // た行
  35, 36, 37, 38, // は行(ふ=145 不触发)
  74, 75, 76, 77, 78, // ぱ行
  83, 84, 85, 86, // Ka Ku Ke Ko
  92, 93, 94, 95, 96, // c 行
  131, 132, 133, 134, 135, // Pa Pu Pe Po Lu
  140, 141, 142, 143, 144, // Tu Ta Ti Te To
  170, 171, 174, 175, 176, 178, 179, 182, 183, 184, 185, // 词中变体段子集
]);

/** が行变体段(187–195)的**词首**改写:→ 浊音 ga..go / Ga..Go。 */
const G_ROW_INITIAL: Record<number, number> = {
  187: 54, 188: 55, 189: 56, 190: 57, 191: 58,
  192: 117, 193: 118, 194: 119, 195: 120,
};

/** が行变体段的**词中**改写:→ 鼻浊音 va..vo / Va..Vo。 */
const G_ROW_MEDIAL: Record<number, number> = {
  187: 49, 188: 50, 189: 51, 190: 52, 191: 53,
  192: 113, 193: 114, 194: 115, 195: 116,
};

/** 词中变体段(170–186)的"词首形态"改写表。 */
const WORD_INITIAL_ID: Record<number, number> = {
  170: 16, 171: 17, 172: 21, 173: 22, 174: 28, 175: 29, 176: 36,
  177: 145, 178: 75, 179: 76, 180: 87, 181: 89, 182: 92, 183: 94,
  184: 140, 185: 142, 186: 147,
};

/**
 * 两个改写遍(与原版逐条对应):
 *
 *  1. が行遍(187–195):前一个 id 是控制/标点(2..9,含序列开头)
 *     → 词首形态 ga..go;否则(前面是假名或 ')→ 词中形态 va..vo。
 *  2. 词中变体遍(170–186):
 *     - 下一个假名是清阻塞音起音,且自己不是紧跟在大写体之后
 *       → 大写元音体(id−17,如 ki→kI);
 *     - 后面是真正的 。/？ → 仅当词内已有重音时才大写;
 *     - 后面是 , 或 、 → 一律不大写;
 *     - 其余 → 词首形态。
 */
export function normalizeKanaIds(seq: number[]): number[] {
  // 第一遍:が行改写 —— prev ∈ 2..9(或序列开头)按词首表
  let prev = 8;
  for (let i = 0; i < seq.length; i++) {
    let id = seq[i];
    if (id >= 187 && id <= 195) {
      id = (prev > 1 && prev < 10 ? G_ROW_INITIAL : G_ROW_MEDIAL)[id];
      seq[i] = id;
    }
    prev = id;
  }

  // 第二遍:词中变体段改写 —— 大写元音体 / 词首形态二选一
  prev = 8;
  let wordPos = 0;
  let accentPos = 0;
  for (let i = 0; i < seq.length; i++) {
    let id = seq[i];
    if (id === 1) {
      accentPos = wordPos; // ' 把重音标记在当前的音节计数上
    } else if (id > 1 && id < 10) {
      wordPos = 0; // 标点/控制:下一个假名开始新词
      accentPos = 0;
      prev = id;
    } else {
      if (id >= 170 && id <= 186) {
        const nextRaw = i + 1 < seq.length ? seq[i + 1] : 0;
        let uppercase: boolean;
        if ((prev >= 153 && prev <= 169) || nextRaw === 6 || nextRaw === 7) {
          uppercase = false; // 紧跟大写体之后 / 后面是 , 、 → 普通形态
        } else if (nextRaw === 8 || nextRaw === 9) {
          // 后面是真正的 。/?:仅词内有重音时大写
          uppercase = wordPos !== 0 && accentPos !== 0;
        } else {
          // 跳过 ' 和控制 id 找下一个假名,由它的辅音决定
          let j = i + 1;
          while (j < seq.length && seq[j] > 0 && seq[j] < 10) j++;
          const nextKana = j < seq.length ? seq[j] : 0;
          uppercase = ONSET_TRIGGER_IDS.has(nextKana);
        }
        id = uppercase ? id - 17 : (WORD_INITIAL_ID[id] ?? id);
        seq[i] = id;
      }
      wordPos++;
      prev = id;
    }
  }
  return seq;
}
