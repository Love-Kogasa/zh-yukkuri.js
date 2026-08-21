/**
 * 引擎核心契约 —— 五级流水线共享的词汇表(类型与定点运算助手)。
 *
 * 架构要点:原版引擎把全部合成状态放在同一块按固定分区布局的内存里,
 * 我们用 core/synth-arena.ts 显式镜像这套布局。这样"跨短语读到残留"
 * 是内存模型的物理事实,而不是散落在各参数里的特例。
 */

/** 音素在目录里的五种角色。 */
export const PhonemeKind = {
  /** 音节主体("ka"、"sU" 等)—— 稳态帧 + 自动过渡。 */
  BODY: 1,
  /** 辅音起音("+k"、",s")—— 从上一个主体桥接过来。 */
  ONSET: 2,
  /** 滑音过渡("+a" 元音追加、"u-" 长音)。 */
  TRANSITION: 3,
  /** 词首送气引子(";k"、";s")—— 带气息的起音。 */
  LEAD: 4,
  /** 释放尾("a;"、"##")—— 衰减收尾。 */
  TAIL: 5,
} as const;
export type PhonemeKind = (typeof PhonemeKind)[keyof typeof PhonemeKind];

/**
 * 帧尺寸标志,存放在每个音素音高字(word)的高两位。
 * 语速 100 时各标志对应的每帧样本数:无 40 / bit14 50 / bit15 60 /
 * 两位都置 70;随语速控制字整体缩放。
 */
export const FrameSizeFlag = {
  NONE: 0x0000,
  SAMPLES_50: 0x4000,
  SAMPLES_60: 0x8000,
} as const;

/** 渲染管线族:B 族在逐样本输出前加调制与自动增益。 */
export type RenderFamily = "A" | "B";
/** B 族的逐样本调制变体。 */
export type RenderModulation = "negate16" | "gate8";

/** 音高轮廓公式参数(查表数据 8 个 voice 共享,换算系数每族不同)。 */
export interface PitchFormula {
  /** 60 组 [idx, N, acc, type] —— 重音模式搜索表。 */
  t15ff4: number[];
  /** 120 行 × 10 列 —— 音高锚点表。 */
  t161d4: number[];
  /** 分词级音高乘数(8 个 voice 均为 0x520)。 */
  coef: number;
  /** A 族的基准偏移(0x33c0)。 */
  base: number;
  /** B 族换算:dvd ×10+0xf00、jgr ×210+0x2300、imd1 ×130+0x1900。 */
  familyB?: { mult: number; offset: number };
}

/** 数据表文件(data/aquespeak_data_{voice}.ts)导出的内容。 */
export interface VoiceTables {
  WAVE4096: Int16Array;
  WINDOW: Int16Array;
  PHONEME_PARAMS: Record<number, Int16Array>;
  F0TABLE: Int16Array;
  TABLE_8300: { k: string; v: number }[];
  TABLE_13D30: Record<number, number>;
  KANA: { bytes: number[]; id: number }[];
}

/** 每个 voice 特有的代码常量(从各原版引擎的代码段提取)。 */
export interface VoiceConstants {
  f0Numerator: number;
  pitchAnchor: number;
  noiseTableLength: number;
  pulseWindowThreshold: number;
  renderFamily: RenderFamily;
  renderModulation: RenderModulation;
  /** 仅 m2:单音节实际周期 687,与代码段锚点 686 差 1。 */
  singleMoraPitchOverride?: number;
  /** 问号升调分母的附加项:默认 0x1900;dvd 0x500、imd1 0xc80。 */
  questionRiseOffset?: number;
  /**
   * 音素条目在共享缓冲区里的字段序:
   * true(非 f1 的 7 个 voice)= { 音高字 @+0, 名字 @+2 };
   * false(f1)= { 名字 @+0, 音高字 @+2 }。
   * 分词末尾促音读残留时,幻影后继的 id 与 f0 分别落在不同的字节上,
   * 字段序决定从哪两个字节取值。
   */
  phonemeWordFirst?: boolean;
  pitchFormula: PitchFormula;
}

/** 一条目录项(具名音素:名字 + 角色 + 帧数 + 参数表槽位)。 */
export interface CatalogEntry {
  name: string;
  kind: PhonemeKind;
  frameCount: number;
  slot: number;
}

/** 装配完成的 voice:数据表 + 常量 + 解码后的查表。 */
export interface Voice {
  readonly tables: VoiceTables;
  readonly constants: VoiceConstants;
  /** ASCII 音素名 → 目录项。 */
  readonly catalog: ReadonlyMap<string, CatalogEntry>;
  /** 假名 id → 目录项(已应用运行时覆盖)。 */
  readonly byKanaId: ReadonlyMap<number, CatalogEntry>;
}

/**
 * 音素缓冲区的一条中间表示 —— 第四级(展开)与第五级(帧合成)
 * 之间唯一的交接契约。
 */
export interface PhbufEntry {
  /** 两个字符的 ASCII 音素名。 */
  name: string;
  kind: PhonemeKind;
  frameCount: number;
  slot: number;
  /** 低 14 位是音高;高 2 位是帧尺寸标志。 */
  pitchWord: number;
  /**
   * 名字在目录里查不到时为真 → 整句 102 错误。
   * 由统一构造器产生:残留字节解出的 id 若映射到目录外的名字
   * (如 "&&"、"##"),就是这条路径。
   */
  invalid?: boolean;
}

/** 一帧合成参数:激励控制 + 11 个 FIR 系数。 */
export interface SynthesisFrame {
  sampleCount: number;
  pulsePeriod: number;
  noiseGain: number;
  pulseGain: number;
  firCoefficients: Int16Array;
}

/** 短语内的一个分词:{ 魔数 0xAB, 音节数 N, 重音 acc, 类型, 系数, id 数组, f0 数组 }。 */
export interface PhraseToken {
  N: number;
  acc: number;
  type: number;
  coef: number;
  ids: number[];
  f0: number[];
  /** f0[pos] 来自"兜底基准值"路径的槽位(区别于外推/融合写入的槽位)。 */
  baseMask: boolean[];
}

/** 帧序列化的旁路信息(槽位对 + 插值权重 + 尺寸标志)。 */
export interface FrameMeta {
  /** 帧移向的槽位(toSlot)。 */
  p5: number;
  /** 帧来自的槽位(fromSlot)。 */
  p6: number;
  /** 音素内插值权重字节。 */
  weight: number;
  /** 源音素的尺寸标志位(0/0x4000/0x8000/0xc000)。 */
  flags: number;
}

/** 错误码,与原版引擎的返回一致。 */
export type SynthesisError = 102 | 105;

// ============================================================================
// 定点运算助手(严格复刻 i386 整数语义)
// ============================================================================

/** 32 位截断乘法(等价于 x86 imul)。 */
export function imul32(a: number, b: number): number {
  return Math.imul(a, b) | 0;
}

/**
 * 带符号偏置的 2^n 除法(x86 `cltd; and; add; sar` 序列):
 * 负数时先加偏置再右移,即"向零截断"而不是"向负无穷取整"。
 * DSP 循环里的 /128、/1024 用它;短语间隙也用它——语速为非 2 的幂
 * (如 150)时,截断与四舍五入会差一个样本,必须严格区分。
 */
export function dividePow2Rounded(x: number, shift: number): number {
  const signBits = x < 0 ? -1 : 0;
  const bias = signBits & ((1 << shift) - 1);
  return (x + bias) >> shift;
}

/**
 * 定点插值:按 w/256 从 a 过渡到 b,带符号偏置的舍入,结果回绕到
 * 16 位。用于音高、增益和参数表的平滑过渡。
 */
export function interpolateFixed8(a: number, b: number, w: number): number {
  let product = (b - a) * w;
  const signBits = product < 0 ? -1 : 0;
  product += signBits & 0xff;
  return (a + (product >> 8)) & 0xffff;
}

/** 按 w(0..255)插值两张 11 字参数表,值为有符号 i16。 */
export function interpolateParams(tableA: Int16Array, tableB: Int16Array, w: number): Int16Array {
  const out = new Int16Array(11);
  for (let i = 0; i < 11; i++) {
    out[i] = interpolateFixed8(tableA[i], tableB[i], w);
  }
  return out;
}
