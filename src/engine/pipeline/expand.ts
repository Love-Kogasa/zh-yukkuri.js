/**
 * 第四级 —— 统一音素构造器(整个引擎的灵魂)。
 *
 * 核心设计:每个假名 id 恰好对应**一个**构造分支。无论这个 id 是
 * 从输入流里来的真假名,还是促音越界读到的"幻影"(共享缓冲区里
 * 分词队列之后的残留字节),都进同一个分支 —— 不存在单独的
 * "幻影特例路径"。三个经原版实测确认的典型:
 *
 *   f1 `い,あっ`   残留 id=69(CV "ba")→ 促音的起音抑制仍在生效,
 *                  只发主体 "ba",音高字 = F0分子/f0 & 0xffff
 *   f2 `うぃ？へっ` 残留 id=14(元音)→ 词尾元音分支:"+o" 滑音追加
 *                  (释放尾由循环尾统一补),音高字 = word2(f0=0 → 0)
 *   f2 `い,あっ`   残留 id=2(控制记号)→ 运行时名 "&&" → 目录查不到
 *                  → 非法条目 → 错误 102
 */
import type { PhbufEntry, Voice, CatalogEntry } from "../core/types.js";
import { PhonemeKind, FrameSizeFlag } from "../core/types.js";
import type { SynthArena } from "../core/synth-arena.js";
import { runtimeNameOf } from "../voice.js";
import { moraPulsePeriod } from "./pitch.js";

/** 短语展开上下文(第三级与短语链已算好的东西)。 */
export interface PhraseContext {
  /** F0 系数:MULT[上一短语类型 × 7 + 收边类型]。 */
  coef: number;
  /** 收边本短语的分词类型(边界 id 6..9,默认 8)。 */
  tokenType: number;
  /** 收边类型来自流里真实的边界元素时为真。 */
  endIsBoundary?: boolean;
  /** ？ 短语的句尾升调周期(0 = 无)。 */
  tailRisePeriod: number;
  /** 末分词被 `+`/`/`/`;` 关闭时为真:不发释放尾。 */
  noTailRelease?: boolean;
  /**
   * 共享缓冲区:只要短语里可能出现"分词末尾促音"就可能要做残留读。
   * 残留字节位于读侧分词音节数组刚过去的位置 —— 精确偏移见
   * tokenInfo.queueEnd。
   */
  arena?: SynthArena;
  /**
   * 分词边界信息(下标 = 音节位置,与 seq 里的假名顺序一致):
   *   isTail[k]   —— 第 k 个假名是其分词的最后一个音节
   *   queueEnd[k] —— 该分词音节数组末尾再往后的字节偏移
   *                 (队列布局下的 Σ_{j≤t} 6 + 4·N_j)
   * 促音的"后继游标"走在**分词的音节数组**上(不是短语的 id 流):
   * 分词末尾的促音会读 queueEnd 处的 4 个字节 —— 有下一个分词时
   * 是它的头部字节(id 落在重音字节上,通常是 0 → "##" → 102),
   * 没有时就是上一短语的帧记录残留(经典的跨短语幻影)。
   */
  tokenInfo?: { isTail: boolean[]; queueEnd: number[] };
}

/** 分词重音:最后一个 `'`(id 1)标记时的音节计数。 */
function accentOf(seq: number[]): number {
  let n = 0;
  let acc = 0;
  for (const id of seq) {
    if (id >= 10) n++;
    else if (id === 1) acc = n;
  }
  return acc;
}

/** 分词音节数(假名 id ≥ 10 才计数,控制记号不占)。 */
function moraCountOf(seq: number[]): number {
  let n = 0;
  for (const id of seq) if (id >= 10) n++;
  return n;
}

/**
 * 位置 i 之后的下一个假名 id(跳过 `'` 重标记)—— 上下文规则
 * 要"隔着引号看下一个假名"。
 */
function nextKanaId(seq: number[], i: number): number | undefined {
  for (let k = i + 1; k < seq.length; k++) {
    const id = seq[k];
    if (id === 1) continue;
    return id;
  }
  return undefined;
}

/** 元音假名 id 10..14 = a i u e o。 */
const VOWEL_CHARS = "aiueo";

/** 词中位置会触发大写元音体的假名 id 集合。 */
const UPPER_VOWEL_KANA = new Set([170, 171, 172, 177, 180, 182, 183]);

/** 触发大写元音体的辅音集合("ktpch")。 */
const UPPER_ONSET_CONSONANTS = "ktpch";

/** 词中が行的 g→v 辅音变化表。 */
const MEDIAL_G_TO_V: Record<number, string> = {
  187: "va", 188: "vi", 189: "vu", 190: "ve", 191: "vo",
  192: "Va", 193: "Vu", 194: "Ve", 195: "Vo", // 拗音が行
};

/** 词首辅音 → 送气引子辅音(清化合并:k/t/p/c 系 → "k" 等)。 */
function leadConsonant(c: string): string {
  if ("ktpcKLTPgGdDbB".includes(c)) return "k";
  if ("sShHSf".includes(c)) return "s";
  if ("nNmM".includes(c)) return "n";
  if ("rR".includes(c)) return "r";
  if ("zj".includes(c)) return "z";
  if ("vV".includes(c)) return "v";
  if ("wy".includes(c)) return "y";
  return ""; // 无引子
}

/** 词中辅音 → 起音辅音(同样的清化合并)。 */
function onsetConsonant(c: string): string {
  if ("ktpcKLTP".includes(c)) return "k";
  if ("sSf".includes(c)) return "s";
  if ("nNmM".includes(c)) return "n";
  if ("hH".includes(c)) return "h";
  if ("rR".includes(c)) return "r";
  if ("gGdD".includes(c)) return "g";
  if ("bB".includes(c)) return "b";
  if ("zj".includes(c)) return "z";
  if ("vV".includes(c)) return "v";
  if ("wy".includes(c)) return "w";
  return ""; // 无起音
}

/** 大写元音体(ki→kI、ku→kU):仅当后面是 {k,t,p,c,h} 辅音;
 *  は行拗音(Ha/Hu/He/Ho)不触发。返回 null 表示用普通主体。 */
function uppercaseVariantName(
  byKanaId: ReadonlyMap<number, CatalogEntry>,
  id: number,
  bodyName: string,
  nextId: number | undefined,
): string | null {
  if (!UPPER_VOWEL_KANA.has(id) || !nextId || bodyName.length < 2) return null;
  const vowel = bodyName[1];
  const upperVowel = vowel === "i" ? "I" : vowel === "u" ? "U" : null;
  if (!upperVowel) return null;
  const nextEntry = byKanaId.get(nextId);
  if (!nextEntry) return null;
  const nextConsonant = nextEntry.name[0].toLowerCase();
  if (!UPPER_ONSET_CONSONANTS.includes(nextConsonant)) return null;
  if ([101, 102, 103, 104].includes(nextId)) return null; // Ha/Hu/He/Ho
  return bodyName[0] + upperVowel;
}

/** 词中主体变体:g→v 变化 + 大写元音规则。 */
function medialBodyName(
  byKanaId: ReadonlyMap<number, CatalogEntry>,
  id: number,
  nextId: number | undefined,
): string | null {
  if (MEDIAL_G_TO_V[id]) return MEDIAL_G_TO_V[id];
  const entry = byKanaId.get(id);
  if (!entry) return null;
  if (UPPER_VOWEL_KANA.has(id) && nextId) {
    return uppercaseVariantName(byKanaId, id, entry.name, nextId);
  }
  return null;
}

/**
 * 把假名 id 序列展开成音素缓冲条目(带每音节音高与上下文变体规则)。
 */
export function expandPhonemes(
  seq: number[],
  voice: Voice,
  ctx: PhraseContext,
  moraPitches?: number[],
): PhbufEntry[] {
  const { catalog, byKanaId, constants } = voice;
  const phs: PhbufEntry[] = [];
  const accent = accentOf(seq);
  const moraCount = moraCountOf(seq);
  const isSingleMora = moraCount === 1;

  /**
   * 按 ASCII 名取条目;force60 强制 60 样本帧标志。音高参数是
   * **完整的 16 位字**:流水线的除法回绕可能已把标志位泄进了
   * 周期值(负 f0 的 0x85BD…),所以按位 OR 整个字而不是截到
   * 0x3fff —— 正常的正周期(< 0x4000)不受影响。
   */
  const phoneme = (name: string, pitch: number, force60 = false): PhbufEntry | null => {
    const e = catalog.get(name);
    if (!e) return null;
    const flag =
      e.kind === PhonemeKind.TAIL || force60 ? FrameSizeFlag.SAMPLES_60 : FrameSizeFlag.NONE;
    return {
      name,
      kind: e.kind,
      frameCount: e.frameCount,
      slot: e.slot,
      pitchWord: (flag | (pitch & 0xffff)) & 0xffff,
    };
  };
  /**
   * 带显式完整 16 位音高字的条目(促音幻影路径专用):
   * word2 = F0分子/f0 & 0xffff,回绕产生的标志位原样保留
   * (f0=2 会回绕成 50 样本帧标志)。
   */
  const phonemeWord = (name: string, pitchWord: number): PhbufEntry | null => {
    const e = catalog.get(name);
    if (!e) return null;
    return {
      name,
      kind: e.kind,
      frameCount: e.frameCount,
      slot: e.slot,
      pitchWord: pitchWord & 0xffff,
    };
  };
  /** 按运行时名直接造条目(目录查不到 → 非法 → 102)。 */
  const rawName = (name: string, pitchWord: number): PhbufEntry => ({
    name,
    kind: 0 as PhonemeKind,
    frameCount: 0,
    slot: 0,
    pitchWord: pitchWord & 0xffff,
    invalid: true,
  });
  const push = (p: PhbufEntry | null) => {
    if (p) phs.push(p);
  };
  const lastBodyVowel = (): string => {
    if (!phs.length) return "";
    const nm = phs[phs.length - 1].name;
    // 长音 "-" 尾要回扫:原版的"前一音节"链会跳过 ー,
    // 所以 ー 后面的元音要跟 ー **之前**的元音比
    // (`よーお` → 第二个 "o-",而不是 "+o")—— 取 nm[0]。
    if (nm.endsWith("-")) return nm[0];
    return nm[1] ?? "";
  };

  const isVowel = (id: number) => id >= 10 && id <= 14;
  let skipNextOnset = false; // 促音置位:它顶替了下一个 CV 的起音
  let moraIdx = 0; // 促音自己也占一个音节位置
  // ？ 短语结尾:释放尾携带升调周期
  const tailPitch = (plain: number): number => ctx.tailRisePeriod || plain;

  for (let i = 0; i < seq.length; i++) {
    const id = seq[i];
    // `'`(1)与控制记号 `&`(2)/`+`(3)/`/`(4)/`;`(5)既不产音素
    // 也不占音节位;它们的 F0 作用在第三级(分词流水线)里
    if (id >= 1 && id <= 5) continue;
    // 词首/词尾按**音节下标**判定:' 不移动音节位置,
    // 所以不能用循环下标 i
    const first = moraIdx === 0;
    const last = moraIdx === moraCount - 1;
    // 流水线预计算的音高;单分词的朴素路径现场推导
    const moraPitch = moraPitches
      ? moraPitches[moraIdx]
      : isSingleMora
        ? accent !== 0
          ? moraPulsePeriod(voice, 0, 1, ctx.coef, ctx.tokenType, accent)
          : (constants.singleMoraPitchOverride ?? constants.pitchAnchor)
        : moraPulsePeriod(voice, moraIdx, moraCount, ctx.coef, ctx.tokenType, accent);

    if (isVowel(id)) {
      const vowel = VOWEL_CHARS[id - 10];
      if (first && last) {
        // 单独元音:稳态主体 + 释放尾
        push(phoneme(";" + vowel, moraPitch, true));
        if (!ctx.noTailRelease) push(phoneme(vowel + ";", tailPitch(moraPitch)));
      } else if (first) {
        push(phoneme(";" + vowel, moraPitch));
      } else if (last) {
        // 词尾:同元音 → 长音 "v-",否则 "+v" 追加;
        // 释放尾由下面的循环尾统一补
        if (lastBodyVowel() === vowel) {
          push(phoneme(vowel + "-", moraPitch, true));
        } else {
          push(phoneme("+" + vowel, moraPitch, true));
        }
      } else {
        // 词中:只追加("+v" 或长音 "v-"),无释放尾
        if (lastBodyVowel() === vowel) {
          push(phoneme(vowel + "-", moraPitch));
        } else {
          push(phoneme("+" + vowel, moraPitch));
        }
      }
      // 促音的起音抑制只覆盖**一个**假名 —— 元音追加消耗了它,
      // 之后的 CV 恢复自己的起音(原版实测 `っうじ`:发 +u 后
      // じ 仍然生成 "+j")
      skipNextOnset = false;
    } else if (id === 150) {
      // 拨音 ん(引擎内部名 "x"):单独 ";x"+"x;",词首 ";x",词中 "+x"
      if (first && last) {
        push(phoneme(";x", moraPitch, true));
        if (!ctx.noTailRelease) push(phoneme("x;", tailPitch(moraPitch)));
      } else if (first) {
        push(phoneme(";x", moraPitch)); // 40 样本帧(不置 bit15)
      } else {
        // 词中 ん:前一个也是 ん系主体时长音形式 "x-"(14 帧)
        // 取代 "+x"(原版 `んん` = ;x(5) x-(14) x;(5);んー/んーん 同)
        const prevNm = phs.length ? phs[phs.length - 1].name : "";
        const prevIsX = prevNm === "x-" || prevNm[1] === "x";
        push(phoneme(prevIsX ? "x-" : "+x", moraPitch, last));
      }
      // 与元音追加相同的单假名作用域(`っんぬ` 保留 ぬ 的 "+n")
      skipNextOnset = false;
    } else if (id === 151) {
      // 促音 っ:"+q"(后面是 s/S 时 "+Q"),共用本音节的音高,
      // 抑制下一个 CV 的起音,自己消耗一个音节位置。
      //
      // 后继游标走**本分词**的音节数组:
      //  - 分词中间 → 流里下一个假名 id(合法取值)
      //  - 分词末尾 → mora[N] 越界:原版读的是音节数组刚过去的
      //    4 个字节(下一分词的头部,或跨短语的残留),并把它喂给
      //    与真假名**同一个**构造器 —— 哪怕本短语后面的分词还有
      //    假名(`みおっ;すしこ` → 原版报 102)
      const nextId = nextKanaId(seq, i);
      const tokenTail = ctx.tokenInfo?.isTail[moraIdx] ?? (nextId === undefined);
      let staleId = -1;
      let staleF0 = 0;
      if (tokenTail) {
        const off = ctx.tokenInfo?.queueEnd[moraIdx] ?? 0;
        const stale = ctx.arena
          ? ctx.arena.readStaleEntry(off)
          : { id: 0, f0: 0 };
        staleId = stale.id;
        staleF0 = stale.f0;
      }
      const succName = tokenTail
        ? runtimeNameOf(staleId)
        : byKanaId.get(nextId!)?.name;
      const name =
        succName && (succName[0] === "s" || succName[0] === "S") ? "+Q" : "+q";
      push(phoneme(name, moraPitch, first)); // 词首促音:50 样本帧
      if (tokenTail) {
        // 残留 id 进统一构造器(与真假名同一个分支,见文件头)。
        // 幻影消耗掉起音抑制,后续分词的假名保留起音。
        emitPhantom(staleId, staleF0);
        skipNextOnset = false;
      } else {
        skipNextOnset = true;
      }
    } else if (id === 152) {
      // 长音 ー:延长前一个主体的元音。连续 ー(`あーー`)保持该
      // 元音;大写体降为小写;前面是 ん 则给 "x-"(`んー` 与
      // `んん` 完全同音)。
      let vowel = "";
      for (let k = phs.length - 1; k >= 0; k--) {
        const nm = phs[k].name;
        const c = nm.endsWith("-") ? nm[0] : (nm[1] ?? "");
        if ("aiueo".includes(c)) {
          vowel = c;
          break;
        }
        if ("AIUO".includes(c)) {
          vowel = c.toLowerCase();
          break;
        }
        if (c === "x") {
          vowel = "x";
          break;
        }
      }
      push(phoneme((vowel || "a") + "-", moraPitch));
    } else {
      // CV 音节
      const entry = byKanaId.get(id);
      if (!entry) {
        moraIdx++;
        continue;
      }
      const cvName = entry.name;
      const consChar = cvName[0];
      // 注意:这里不做名字级的"边界前大写"—— 第二级的 id 规范化
      // 已经拍板了变体(包括 ' 位置规则:`そし'。` 在扫到重音前
      // 判定,保持词首形)
      if (skipNextOnset) {
        // 促音之后:不起音,主体变体规则照常
        const variant = MEDIAL_G_TO_V[id]
          ? null
          : medialBodyName(byKanaId, id, last ? undefined : nextKanaId(seq, i));
        skipNextOnset = false;
        push(phoneme(variant ?? cvName, moraPitch, last));
      } else if (first) {
        // 词首:送气引子 ";C" + 主体(g→v 不适用)
        const variant = MEDIAL_G_TO_V[id] ? null : medialBodyName(byKanaId, id, nextKanaId(seq, i));
        const lead = leadConsonant(consChar);
        if (lead) push(phoneme(";" + lead, 0));
        push(phoneme(variant ?? cvName, moraPitch));
      } else {
        // 词中/词尾:先定变体(引擎读的是变体名),
        // 且连续两个大写元音体不叠加
        const prevHasUpperVowel = "AIUO".includes(lastBodyVowel());
        const variant = prevHasUpperVowel
          ? (MEDIAL_G_TO_V[id] ?? null)
          : medialBodyName(byKanaId, id, last ? undefined : nextKanaId(seq, i));
        const bodyName = variant ?? cvName;
        const bodyConsonant = bodyName[0];
        const mappedOnset = onsetConsonant(bodyConsonant);

        // 起音分派看**前一个音素**的次字符
        const prevChar = lastBodyVowel();
        const prevIsPlainVowel = "aiueox".includes(prevChar);
        const prevIsUpperVowel = "AIUO".includes(prevChar);
        if (prevIsPlainVowel && mappedOnset) {
          push(phoneme("+" + mappedOnset, 0, last));
        } else if (prevIsUpperVowel) {
          // 大写元音体之后用压缩起音 ",k"/",s"
          if ("ktpcKTLP".includes(bodyConsonant)) {
            push(phoneme(",k", 0, last));
          } else if ("sShHf".includes(bodyConsonant)) {
            push(phoneme(",s", 0, last));
          } else if (mappedOnset) {
            // 此处置 "V;"+";C" 的路径未经原版实测验证,
            // 引擎保守地用普通起音
            push(phoneme("+" + mappedOnset, 0, last));
          }
        } else if (mappedOnset) {
          push(phoneme("+" + mappedOnset, 0, last));
        }
        push(phoneme(bodyName, moraPitch, last));
      }
    }
    moraIdx++;
  }

  /**
   * 促音的越界后继:把残留 id 送进与真假名**相同**的分支(上面的
   * 循环体逻辑),音高字 = F0分子/f0 & 0xffff(16 位回绕保留标志位
   * —— f0=2 回绕成 50 样本帧标志;f0=0 时写 0)。释放尾不在这里发
   * —— 由下面的循环尾统一负责。
   */
  function emitPhantom(id: number, f0: number): void {
    const word2 =
      f0 === 0 ? 0 : Math.floor(constants.f0Numerator / f0) & 0xffff;
    if (isVowel(id)) {
      // 词尾元音分支:同元音长滑音 "v-",否则 "+v"
      const vowel = VOWEL_CHARS[id - 10];
      if (lastBodyVowel() === vowel) {
        push(phonemeWord(vowel + "-", word2));
      } else {
        push(phonemeWord("+" + vowel, word2));
      }
    } else if (id === 150) {
      // 促音后的词中 ん:按同样的"前一个 ん"规则给 "+x"/"x-"
      const prevNm = phs.length ? phs[phs.length - 1].name : "";
      const prevIsX = prevNm === "x-" || prevNm[1] === "x";
      push(phonemeWord(prevIsX ? "x-" : "+x", word2));
    } else if (id === 152) {
      // 长音:延长前一个主体的元音(同样的回扫)
      let vowel = "";
      for (let k = phs.length - 1; k >= 0; k--) {
        const nm = phs[k].name;
        const c = nm.endsWith("-") ? nm[0] : (nm[1] ?? "");
        if ("aiueo".includes(c)) { vowel = c; break; }
        if ("AIUO".includes(c)) { vowel = c.toLowerCase(); break; }
        if (c === "x") { vowel = "x"; break; }
      }
      push(phonemeWord((vowel || "a") + "-", word2));
    } else if (id >= 10) {
      // CV:促音的起音抑制仍然生效 —— 只发主体
      // (f1 `い,あっ`:"ba",没有 "+b")。用运行时名覆盖目录条目
      // 不同的 id;目录没有的名字 → 非法 → 102
      const nm = runtimeNameOf(id);
      push(phonemeWord(nm, word2) ?? rawName(nm, word2));
    } else {
      // 控制记号(含 0):运行时名原样进目录 —— "##"/"&&"/双字符名
      // 都查不到 → 非法 → 错误 102
      const nm = runtimeNameOf(id);
      push(phonemeWord(nm, word2) ?? rawName(nm, word2));
    }
  }

  // 结尾释放 "V;":匹配最后一个音素的元音(除非已是释放尾)。
  // 只有 ' 的空分词(音节数 0)保持空 —— 原版对它不渲染任何帧。
  // 被 `+`/`/`/`;` 关闭的末分词同样不发释放尾。
  if (moraCount === 0) return phs;
  const lastPh = phs.length ? phs[phs.length - 1] : null;
  if (!ctx.noTailRelease && (!lastPh || lastPh.kind !== PhonemeKind.TAIL)) {
    const vowel =
      lastPh && lastPh.kind === PhonemeKind.TRANSITION && lastPh.name.endsWith("-")
        ? lastPh.name[0]
        : lastPh
          ? lastPh.name[1]
          : "a";
    // 只有最后一个音节的名字在 [1] 位带元音(a/i/u/e/o/x 或大写
    // A/I/U/O)才发 "v;" 释放 —— 名字不是元音的后继(如 "&&")
    // 使短语无释放尾地结束,这恰好就是非法输入的情形
    if ("aiueoxAIUO".includes(vowel)) push(phoneme(vowel + ";", tailPitch(0)));
  }

  markFrameSizeFlags(phs);
  fillZeroPitches(phs, voice);
  return phs;
}

/**
 * 语句尾的帧尺寸标志:先全部清零,最后两个音素标 60 样本,
 * 倒数第三个标 60 或 50(促音 q/Q 为 50)—— 除非被长音 "-" 尾
 * 或 "+V" 追加阻断。
 */
function markFrameSizeFlags(phs: PhbufEntry[]): void {
  for (const ph of phs) ph.pitchWord &= 0x3fff;
  if (phs.length < 2) return;
  const n = phs.length;
  phs[n - 1].pitchWord = (phs[n - 1].pitchWord & 0x3fff) | FrameSizeFlag.SAMPLES_60;
  phs[n - 2].pitchWord = (phs[n - 2].pitchWord & 0x3fff) | FrameSizeFlag.SAMPLES_60;
  if (n >= 3) {
    const secondLast = phs[n - 2].name;
    const isVowelAppend = secondLast[0] === "+" && "aiueox".includes(secondLast[1]);
    if (secondLast[1] !== "-" && !isVowelAppend) {
      const c = phs[n - 3].name[1];
      if (c !== ";") {
        phs[n - 3].pitchWord =
          (phs[n - 3].pitchWord & 0x3fff) |
          (c === "Q" || c === "q" ? FrameSizeFlag.SAMPLES_50 : FrameSizeFlag.SAMPLES_60);
      }
    }
  }
}

/**
 * 给零音高的音素(引子、起音、追加)从邻值插值出一个音高;
 * 尾部音素向锚点外推。
 */
function fillZeroPitches(phs: PhbufEntry[], voice: Voice): void {
  const anchor = voice.constants.pitchAnchor;
  for (let j = 0; j < phs.length; j++) {
    if ((phs[j].pitchWord & 0x3fff) !== 0) continue;
    let nextIdx = -1;
    for (let k = j + 1; k < phs.length; k++) {
      if ((phs[k].pitchWord & 0x3fff) !== 0) {
        nextIdx = k;
        break;
      }
    }
    const flags = phs[j].pitchWord & 0xc000;
    let pitch: number;
    if (nextIdx >= 0) {
      const next = phs[nextIdx].pitchWord & 0x3fff;
      if (j === 0) {
        // 首音素:锚点 + trunc((next - 锚点) × 5 / 6)
        pitch = anchor + Math.trunc(((next - anchor) * 5) / 6);
      } else {
        const prev = phs[j - 1].pitchWord & 0x3fff;
        pitch = prev + Math.trunc((next - prev) / (nextIdx - j + 1));
      }
    } else if (j < 2) {
      pitch = anchor;
    } else {
      // 外推 2×prev - prevPrev,并夹到锚点
      const prev = phs[j - 1].pitchWord & 0x3fff;
      const prevPrev = phs[j - 2].pitchWord & 0x3fff;
      pitch = Math.min(prev * 2 - prevPrev, anchor);
    }
    // 写回是 (word & 0xc000) | 完整 16 位值 —— 外推出的**负**音高
    // (16 位回绕,如 -63 → 0xffc1)会把 bit14/15 泄进帧尺寸标志
    // (`を,っ`:u; 变 70 样本帧,原版实测)。在这里截到 0x3fff
    // 会保持 60 样本帧并丢掉两帧的时长。
    phs[j].pitchWord = (flags | (pitch & 0xffff)) & 0xffff;
  }
}
