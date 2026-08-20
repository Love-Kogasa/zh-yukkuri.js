/**
 * 引擎顶层 —— 语音合成流水线的驱动循环,以及对外暴露的 synth()/run() API。
 *
 * 一句话概括合成过程:
 *   文本 → Shift-JIS 字节 → 假名 id 序列 → 按标点切成短语
 *   → 每个短语独立走「分词 / 音高规划 / 音素展开 / 帧合成 / 波形渲染」
 *   → 短语之间插入静音间隙,拼接成完整 WAV。
 *
 * 两个必须理解的底层事实(它们决定了本文件里的多处"怪"逻辑):
 *
 * 1. 短语之间不共享渲染状态 —— 任一短语的波形与"把它单独合成"完全一致,
 *    因此短语循环里每轮都要重建上下文。
 *
 * 2. 分词队列与帧记录共用一块**从不清零**的内存(见 core/synth-arena.ts)。
 *    原版引擎靠这块"脏内存"工作:短语末尾的促音会读到自己队伍之外的
 *    残留字节,把它当作"下一个假名"来展开(幻影后继)。我们用 SynthArena
 *    忠实复刻这套物理行为,这也是逐字节等价的关键之一。
 */
import type { FrameMeta, SynthesisError, SynthesisFrame, Voice } from "./core/types.js";
import { dividePow2Rounded } from "./core/types.js";
import { SynthArena } from "./core/synth-arena.js";
import {
  createVoice, VOICE_CONSTANTS, VOICE_LOADERS, type VoiceName,
} from "./voice.js";
import { koeToSjis, parseKana, truncateAtControl } from "./pipeline/parse.js";
import { normalizeKanaIds } from "./pipeline/normalize.js";
import { planPhrase, PUNCT_PAUSE, PHRASE_COEF_MULT, isBoundaryId } from "./pipeline/tokenize.js";
import type { PhraseContext } from "./pipeline/expand.js";
import { buildFrames, SOKUON_LOOKUP_FAIL, frameRateControl } from "./pipeline/frames.js";
import { renderFrames, wavBytes } from "./render/render.js";

// ----------------------------------------------------------------------------
// 输入合法性规则(为什么有些句子会被整句拒绝)
// ----------------------------------------------------------------------------

/**
 * 判断一个短语的假名序列是否非法(非法 → 整句报 102 错误)。
 *
 * 三条规则,全部是对原版引擎行为的归纳:
 *
 * 1. 促音(っ)收尾:只在它是**全句第一个被渲染的短语**时才拒绝。
 *    原因见上面"幻影后继"——首短语之前共享内存还是零,促音读到的
 *    残留是 0,查不到对应音素,于是失败;而后续短语的促音能读到
 *    上一短语留下的有效帧记录,反而"能出声"。(`あっ` 报错,
 *    `い,あっ` 正常,就是这个道理。)
 *
 * 2. 长音(ー)出现在短语开头(它前面没有任何假名可延长):拒绝。
 *    回扫时会跨过不占音节的控制记号(' 和 &、以及 + / ; 这类
 *    只关闭分词的符号),所以 `はな;ー` 合法(ー 延长 な 的元音),
 *    而 `あ,ー` / `;ー` 非法。
 *
 * 3. 促音的下一个音节(跳过 ' 和 &)又是促音或长音:拒绝。
 *    (`あっっい` / `あっー` 等都属此类;`+`/`/`/`;` 会关闭分词,
 *    使"下一个音节"落在分词之外,因此 `あっ;ー` 反而合法。)
 */
function isRejected(seq: number[], isFirstPhrase: boolean): boolean {
  let last = -1;
  let count = 0;
  for (const id of seq) {
    if (id === 1) continue; // ' 只标记音高重音,不算音节
    last = id;
    count++;
  }
  if (count === 0) return false; // 只有 ' → 渲染成一个空分词,不算错
  if (last === 151 && isFirstPhrase) return true; // 规则 1:首短语促音尾
  // 规则 2:长音前必须在本短语内先出现过一个真正的假名
  {
    let phraseHasKana = false;
    for (const id of seq) {
      if (id === 1 || id === 2) continue;
      if (id < 10) continue; // 控制记号不重置回扫(はな;ー 的 ; 被跨过)
      if (id === 152 && !phraseHasKana) return true;
      phraseHasKana = true;
    }
  }
  // 规则 3:促音 + (跳过 ' 和 &)促音|长音
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] !== 151) continue;
    for (let k = i + 1; k < seq.length; k++) {
      const id = seq[k];
      if (id === 1 || id === 2) continue;
      if (id === 151 || id === 152) return true;
      break;
    }
  }
  return false;
}

// ----------------------------------------------------------------------------
// 流水线驱动
// ----------------------------------------------------------------------------

/**
 * 全句合成:Shift-JIS 字节 → WAV 字节,或错误码(102/105)。
 *
 * 短语在边界标点(、 , 。 . ？)处切分并独立渲染;短语之间插入
 * 静音间隙,长度 = 停顿值 × 速度系数,再**向零截断**除以 256
 * (注意不是四舍五入——两种舍入在非 2 的幂速度下会差一个样本)。
 * 句尾固定补 256 个零样本。
 */
export function synthesizeChecked(
  voice: Voice,
  sjisInput: Uint8Array,
  speed: number,
): Uint8Array | SynthesisError {
  const seq = parseKana(truncateAtControl(sjisInput), voice);
  if (seq === null) return 105; // 出现假名表匹配不了的字符
  if (seq.length === 0) return new Uint8Array(0); // 空输入 → 空输出(不是错误)
  normalizeKanaIds(seq); // 词首/词中变体归一化(が→゛等上下文重写)

  const f0ctrl = frameRateControl(speed);
  const out: number[] = [];
  let prevType = 8; // 短语类型的链式初值:句首视作句号类
  let phraseNo = 0; // 是否首个渲染短语(决定促音尾拒绝规则)
  // 共享缓冲区:分词队列 + 帧记录,跨短语从不清零(幻影后继的物理来源)
  const arena = new SynthArena({ wordFirst: voice.constants.phonemeWordFirst === true });
  let i = 0;
  while (i < seq.length) {
    // 取一个短语的假名(到边界标记为止,标记本身留给下面的边界段处理)
    let j = i;
    while (j < seq.length && !isBoundaryId(seq[j])) j++;
    const phrase = seq.slice(i, j);

    // 边界段:连续消费所有 id ≤ 9 的记号;最后一个 >1 的 id 成为
    // "下一短语的类型";、 , 。 各自累加停顿时长,？不累加
    let type = -1;
    let pause = 0;
    let k = j;
    while (k < seq.length && seq[k] <= 9) {
      const id = seq[k];
      if (id > 1) type = id;
      pause += PUNCT_PAUSE[id] ?? 0;
      k++;
    }
    const exhausted = k >= seq.length; // 序列耗尽 → 句尾(补 256 零样本)
    if (j >= seq.length) type = 5;

    if (phrase.length > 0) {
      phraseNo++;
      if (isRejected(phrase, phraseNo === 1)) return 102;
      // 收边记号:短语内最后一个未关闭分词的类型(序列结尾时保持 8)
      const tokenType = j < seq.length ? seq[j] : 8;
      // 第三级:分词流水线(音高系数链 + f0 填充 + + 号融合)
      const plan = planPhrase(phrase, voice, prevType, tokenType);
      // 三→四级交接:把分词队列写进共享缓冲区(促音读残留的内存布局来源)
      const queueLen = arena.writeTokenQueue(plan.tokens);
      // 给展开器的分词边界信息:每个假名是否是所属分词的末尾,
      // 以及"该分词的 mora 数组末尾再往后"在队列布局中的字节偏移。
      // 必须与写入队列的是同一份分词数据,两者要保持一致。
      let k2 = 0;
      let off2 = 0;
      const isTail: boolean[] = [];
      const queueEnd: number[] = [];
      for (const t of plan.tokens) {
        off2 += 6 + 4 * t.N;
        for (let m = 0; m < t.N; m++) {
          isTail[k2] = m === t.N - 1;
          queueEnd[k2] = off2;
          k2++;
        }
      }
      const tokenInfo = { isTail, queueEnd };
      void queueLen;
      // 问号升调:最后一个分词以 ？ 收尾且句尾音高非零时,
      // 结尾会追加一段滑音,时长由音高除子与每 voice 的升调偏移决定
      let tailRisePeriod = 0;
      const lastTok = plan.tokens.length ? plan.tokens[plan.tokens.length - 1] : null;
      if (lastTok && lastTok.type === 9 && lastTok.f0[lastTok.N - 1] !== 0) {
        tailRisePeriod = Math.floor(
          voice.constants.f0Numerator /
            (lastTok.f0[lastTok.N - 1] + (voice.constants.questionRiseOffset ?? 0x1900)),
        );
      }
      // 短语上下文(展开器在促音收尾时才会去读共享缓冲区的残留)
      const ctx: PhraseContext = {
        coef: plan.tokens[0]?.coef ?? PHRASE_COEF_MULT[prevType * 7 + tokenType],
        tokenType,
        endIsBoundary: j < seq.length,
        tailRisePeriod,
        noTailRelease: lastTok !== null && lastTok.type >= 3 && lastTok.type <= 5,
        arena,
        tokenInfo,
      };
      // 第四+五级:展开(统一音素构造器,残留字节与真假名走同一条路)
      // → 帧序列
      let frames: SynthesisFrame[];
      const frameMeta: FrameMeta[] = [];
      try {
        frames = buildFrames(phrase, speed, voice, ctx, plan.pitches, frameMeta);
      } catch (e) {
        if (e === SOKUON_LOOKUP_FAIL) return 102; // 残留读到 0 → 音素查表失败
        throw e;
      }
      // 渲染前序列化帧记录(顺序很重要:展开先消费残留,帧记录后写入,
      // 这样下一短语的促音读到的才是本短语的帧)
      arena.serializeFrames(frames, frameMeta);
      for (const s of renderFrames(frames, voice)) out.push(s);
    }

    // 短语后间隙:标点停顿(速度缩放),或句尾固定的 256 个零样本
    const gap = exhausted ? 256 : dividePow2Rounded(f0ctrl * pause, 8);
    for (let g = 0; g < gap; g++) out.push(0);

    prevType = type;
    i = k;
  }
  return wavBytes(new Int16Array(out));
}

export { createVoice, VOICE_CONSTANTS, VOICE_LOADERS, isBoundaryId, planPhrase };
export type { VoiceName } from "./voice.js";

// ----------------------------------------------------------------------------
// 对外 API(错误是值,不是异常)
// ----------------------------------------------------------------------------

/**
 * 合成结果,Rust Result 风格:错误以值的形式返回,绝不 throw。
 * code 与原版 DLL 的错误码一致:
 *   102 — 输入被音素规则拒绝(促音/长音位置不合法等)
 *   105 — 输入无法解析(假名表匹配不了的字符)
 */
export type SynthResult =
  | { ok: true; wav: Uint8Array }
  | { ok: false; code: 102 | 105; message: string };

const voiceCache = new Map<VoiceName, Voice>();

/** 加载(并缓存)voice 数据表 —— synth() 与 run() 共用。 */
async function voiceFor(name: VoiceName): Promise<Voice> {
  let voice = voiceCache.get(name);
  if (!voice) {
    voice = createVoice(await VOICE_LOADERS[name](), VOICE_CONSTANTS[name]);
    voiceCache.set(name, voice);
  }
  return voice;
}

/**
 * 把假名字符串合成为 WAV 字节;错误以结果值返回。
 *
 *   const r = await synth("こん'にちわ", { voice: "f2", speed: 150 });
 *   if (r.ok) new Blob([r.wav], { type: "audio/wav" })
 *   else      console.error(r.code, r.message);   // 102 / 105
 *
 * speed:100 = 正常语速;有效范围 50..300。
 */
export async function synth(
  koe: string,
  opts?: { voice?: VoiceName; speed?: number },
): Promise<SynthResult> {
  const voice = await voiceFor(opts?.voice ?? "f1");
  const bytes = koeToSjis(koe);
  if (bytes === null)
    return {
      ok: false,
      code: 105,
      message: "unencodable character in input (DLL error 105)",
    };
  const r = synthesizeChecked(voice, bytes, opts?.speed ?? 100);
  if (typeof r === "number")
    return {
      ok: false,
      code: r,
      message:
        r === 102
          ? "rejected input: sokuon/chouon placement (DLL error 102)"
          : "unparseable input (DLL error 105)",
    };
  return { ok: true, wav: r };
}

/**
 * 向后兼容包装(旧版契约):出错时返回空 Uint8Array 而不是报告错误。
 * 新代码请用 synth()。
 */
export async function run(
  koe: string,
  opts?: { voice?: VoiceName; speed?: number },
): Promise<Uint8Array> {
  const r = await synth(koe, opts);
  return r.ok ? r.wav : new Uint8Array(0);
}
