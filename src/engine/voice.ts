/**
 * Voice 装配:假名 id → 音素名映射、音素目录解码、每个 voice 的常量,
 * 以及数据表的惰性加载。
 *
 * 本模块(乃至整个引擎)不依赖任何 node 专有 API 和运行时第三方库,
 * 保证可以打包成无依赖的纯 JS。数据表在 data/ 目录下按 voice 分文件,
 * 首次使用时才动态 import。
 */
import type { Voice, VoiceConstants, VoiceTables, CatalogEntry, PhonemeKind } from "./core/types.js";
import { TABLE_15FF4, TABLE_161D4 } from "./data/aquespeak_data_f1.js";

export type VoiceName = "f1" | "f2" | "r1" | "m1" | "m2" | "dvd" | "jgr" | "imd1";

// ============================================================================
// 假名 id → 音素名(8 个 voice 共用同一张表)
// ============================================================================

/**
 * 完整的 id→音素名映射(两个 ASCII 字符)。
 * 音素名的编码约定:
 *   首字符是"连接方式"—— ';' 词首引子、'+' 词中过渡、'-' 长音延续;
 *   次字符是"内容"—— 辅音或元音。
 * 因此同一个假名在不同位置会对应不同 id(如 き 词首 "ki"/词中大写 "kI"),
 * 而元音/促音/长音有自己重复形式的名字("aa"…"oo"、"QQ"、"--"):
 * 这些名字的首尾两个字符分别被用于"词首引子构造"和"同元音长音判定"。
 * id 0 的 "##" 是非法哨兵——目录里查不到它,查到即报 102。
 */
export const ID_TO_NAME: Record<number, string> = {
  0: "##", 1: "''", 2: "&&", 3: "++", 4: "//", 5: ";;", 6: ",,", 7: ",,", 8: "..", 9: "??",
  10: "aa", 11: "ii", 12: "uu", 13: "ee", 14: "oo",
  15: "ka", 16: "ki", 17: "ku", 18: "ke", 19: "ko",
  20: "sa", 21: "su", 22: "si", 23: "se", 24: "so",
  25: "ta", 26: "te", 27: "to", 28: "ti", 29: "tu",
  30: "na", 31: "ni", 32: "nu", 33: "ne", 34: "no",
  35: "ha", 36: "hi", 37: "he", 38: "ho",
  39: "ma", 40: "mi", 41: "mu", 42: "me", 43: "mo",
  44: "ra", 45: "ri", 46: "ru", 47: "re", 48: "ro",
  49: "va", 50: "vi", 51: "vu", 52: "ve", 53: "vo",
  54: "ga", 55: "gi", 56: "gu", 57: "ge", 58: "go",
  59: "za", 60: "zu", 61: "zi", 62: "ze", 63: "zo",
  64: "da", 65: "de", 66: "do", 67: "di", 68: "du",
  69: "ba", 70: "bi", 71: "bu", 72: "be", 73: "bo",
  74: "pa", 75: "pi", 76: "pu", 77: "pe", 78: "po",
  79: "ya", 80: "yu", 81: "ye", 82: "yo",
  83: "Ka", 84: "Ku", 85: "Ke", 86: "Ko",
  87: "Si", 88: "Sa", 89: "Su", 90: "Se", 91: "So",
  92: "ci", 93: "ca", 94: "cu", 95: "ce", 96: "co",
  97: "Na", 98: "Nu", 99: "Ne", 100: "No",
  101: "Ha", 102: "Hu", 103: "He", 104: "Ho",
  105: "Ma", 106: "Mu", 107: "Me", 108: "Mo",
  109: "Ra", 110: "Ru", 111: "Re", 112: "Ro",
  113: "Va", 114: "Vu", 115: "Ve", 116: "Vo",
  117: "Ga", 118: "Gu", 119: "Ge", 120: "Go",
  121: "ji", 122: "ja", 123: "ju", 124: "je", 125: "jo",
  126: "Du", 127: "Ba", 128: "Bu", 129: "Be", 130: "Bo",
  131: "Pa", 132: "Pu", 133: "Pe", 134: "Po", 135: "Lu",
  136: "wa", 137: "wi", 138: "we", 139: "wo",
  140: "Tu", 141: "Ta", 142: "Ti", 143: "Te", 144: "To",
  145: "fu", 146: "fa", 147: "fi", 148: "fe", 149: "fo",
  150: "xx", 151: "QQ", 152: "--",
  153: "kI", 154: "kU", 155: "sU", 156: "sI", 157: "tI", 158: "tU",
  159: "hI", 160: "fU", 161: "pI", 162: "pU", 163: "SI", 164: "SU",
  165: "cI", 166: "cU", 167: "TU", 168: "TI", 169: "fI",
  170: "ki", 171: "ku", 172: "su", 173: "si", 174: "ti", 175: "tu",
  176: "hi", 177: "fu", 178: "pi", 179: "pu", 180: "Si", 181: "Su",
  182: "ci", 183: "cu", 184: "Tu", 185: "Ti", 186: "fi",
  187: "ga", 188: "gi", 189: "gu", 190: "ge", 191: "go",
  192: "Ga", 193: "Gu", 194: "Ge", 195: "Go",
};

/**
 * 运行时覆盖表:原版引擎初始化时会改写一部分映射,所以这些 id 的
 * "静态值"和"实际运行值"不同。值为 4 位十六进制,与音素目录的键
 * 格式一致(如 "7375" = "su")。
 */
export const RUNTIME_OVERRIDES: Record<number, string> = {
  21: "7375", 22: "7369", 26: "7465", 27: "746f", 28: "7469", 29: "7475",
  59: "7a61", 60: "7a75", 61: "7a69", 62: "7a65", 63: "7a6f",
  64: "6461", 65: "6465", 66: "646f", 67: "6469", 68: "6475",
  69: "6261", 70: "6269", 71: "6275", 72: "6265", 73: "626f",
  74: "7061", 75: "7069", 76: "7075", 77: "7065", 78: "706f",
  87: "5369", 88: "5361", 92: "6369", 93: "6361", 94: "6375", 95: "6365", 96: "636f",
  113: "5661", 114: "5675", 115: "5665", 116: "566f",
  117: "4761", 118: "4775", 119: "4765", 120: "476f",
  121: "6a69", 122: "6a61", 123: "6a75", 124: "6a65", 125: "6a6f",
  126: "4475", 127: "4261", 128: "4275", 129: "4265", 130: "426f",
  131: "5061", 132: "5075", 133: "5065", 134: "506f", 135: "4c75",
  140: "5475", 141: "5461", 142: "5469",
  145: "6675", 146: "6661", 147: "6669",
  170: "6b69", 171: "6b75", 172: "7375", 173: "7369", 174: "7469", 175: "7475",
  176: "6869", 177: "6675", 178: "7049", 179: "7075",
  180: "5369", 181: "5375", 182: "6369", 183: "6375", 184: "5475", 185: "5469", 186: "6669",
  187: "6761", 188: "7669", 189: "7675", 190: "7665", 191: "766f",
  192: "4761", 193: "4775", 194: "4765", 195: "476f",
};

/** 把 4 位十六进制名("3b6b")解码成 2 个 ASCII 字符(";k")。 */
export function decodePhonemeName(hex: string): string {
  return (
    String.fromCharCode(parseInt(hex.substring(0, 2), 16)) +
    String.fromCharCode(parseInt(hex.substring(2, 4), 16))
  );
}

/**
 * 应用覆盖表后的 id→名查询。与 byKanaId 不同,这里**不**过滤目录里
 * 查不到的名字——id 0 的 "##" 哨兵必须能查到,查目录失败正是
 * "幻影后继读到零残留 → 102 错误"这条路径的触发条件。
 */
export function runtimeNameOf(id: number): string {
  const ov = RUNTIME_OVERRIDES[id];
  if (ov) return decodePhonemeName(ov);
  return ID_TO_NAME[id] ?? "\0\0";
}

/** 装配一个 voice:一次性解码音素目录与 id 查表。 */
export function createVoice(tables: VoiceTables, constants: VoiceConstants): Voice {
  // 音素目录:名字 → {类型, 帧数, 参数表槽位}
  const catalog = new Map<string, CatalogEntry>();
  for (const { k, v } of tables.TABLE_8300) {
    catalog.set(decodePhonemeName(k), {
      name: decodePhonemeName(k),
      kind: (v & 0xff) as PhonemeKind,
      frameCount: (v >> 8) & 0xff,
      slot: (v >> 16) & 0xffff,
    });
  }
  // id → 目录条目的直查表(覆盖表优先于静态表)
  const byKanaId = new Map<number, CatalogEntry>();
  for (const idStr of Object.keys(ID_TO_NAME)) {
    const id = Number(idStr);
    const overrideHex = RUNTIME_OVERRIDES[id];
    const name = overrideHex ? decodePhonemeName(overrideHex) : ID_TO_NAME[id];
    const entry = name ? catalog.get(name) : undefined;
    if (entry) byKanaId.set(id, entry);
  }
  return { tables, constants, catalog, byKanaId };
}

// ============================================================================
// 每个 voice 的常量(从各原版引擎提取)
// ============================================================================

/**
 * 音高公式共享表(8 个 voice 完全相同):
 * 查表得到基准值后按系数缩放,再加基准偏移;B 族渲染另做一次
 * "乘系数+加偏移"的换算(见 pipeline/pitch.ts)。
 */
const PITCH_FORMULA_A = {
  t15ff4: TABLE_15FF4,
  t161d4: TABLE_161D4,
  coef: 0x520,
  base: 0x33c0,
};
const pitchFormulaB = (mult: number, offset: number) => ({
  ...PITCH_FORMULA_A,
  familyB: { mult, offset },
});

/**
 * 常量含义速查:
 *   f0Numerator        音高换算分子(周期 = 分子 / 音高值)
 *   pitchAnchor        单音节/兜底情况下的基准周期
 *   noiseTableLength   噪声源表的回绕长度
 *   pulseWindowThreshold 脉冲振荡器的窗函数阈值(及初始化相位)
 *   renderFamily       渲染族:A = 直接输出;B = 输出前加调制+自动增益
 *   renderModulation   B 族调制变体:negate16(前 16 样本取反)/gate8(第 8 样本置零)
 *   phonemeWordFirst   共享缓冲区里音素条目的字段序(f1 与其余 7 个相反)
 *   singleMoraPitchOverride 单音节周期特例(仅 m2,与其锚点差 1)
 *   questionRiseOffset 问号升调的附加偏移(默认 0x1900)
 */
export const VOICE_CONSTANTS: Record<VoiceName, VoiceConstants> = {
  f1: {
    f0Numerator: 0x3e8000, pitchAnchor: 0x135,
    noiseTableLength: 0x1000, pulseWindowThreshold: 0x255,
    renderFamily: "A", renderModulation: "gate8",
    pitchFormula: PITCH_FORMULA_A,
  },
  f2: {
    f0Numerator: 0x4e2000, pitchAnchor: 0x182,
    noiseTableLength: 0x1000, pulseWindowThreshold: 0x255,
    renderFamily: "A", renderModulation: "gate8",
    phonemeWordFirst: true,
    pitchFormula: PITCH_FORMULA_A,
  },
  r1: {
    f0Numerator: 0x1388000, pitchAnchor: 0x609,
    noiseTableLength: 0x1000, pulseWindowThreshold: 0x255,
    renderFamily: "A", renderModulation: "gate8",
    phonemeWordFirst: true,
    pitchFormula: PITCH_FORMULA_A,
  },
  m1: {
    f0Numerator: 0xd05555, pitchAnchor: 0x406,
    noiseTableLength: 0x1f40, pulseWindowThreshold: 0x87b,
    renderFamily: "A", renderModulation: "gate8",
    phonemeWordFirst: true,
    pitchFormula: PITCH_FORMULA_A,
  },
  m2: {
    f0Numerator: 0x8ae38e, pitchAnchor: 0x2ae,
    noiseTableLength: 0x1f40, pulseWindowThreshold: 0x87b,
    renderFamily: "A", renderModulation: "gate8",
    phonemeWordFirst: true,
    singleMoraPitchOverride: 687,
    pitchFormula: PITCH_FORMULA_A,
  },
  dvd: {
    f0Numerator: 0x3e8000, pitchAnchor: 0x42a,
    noiseTableLength: 0x1f40, pulseWindowThreshold: 0x87b,
    renderFamily: "B", renderModulation: "negate16",
    phonemeWordFirst: true,
    pitchFormula: pitchFormulaB(10, 0xf00),
    questionRiseOffset: 0x500,
  },
  jgr: {
    f0Numerator: 0x3e8000, pitchAnchor: 0x1c9,
    noiseTableLength: 0x1000, pulseWindowThreshold: 0x255,
    renderFamily: "B", renderModulation: "gate8",
    phonemeWordFirst: true,
    pitchFormula: pitchFormulaB(210, 0x2300),
  },
  imd1: {
    f0Numerator: 0x3e8000, pitchAnchor: 0x280,
    noiseTableLength: 0x1000, pulseWindowThreshold: 0x255,
    renderFamily: "A", renderModulation: "gate8", // B 族骨架,但调制/增益被挖空,按 A 处理
    phonemeWordFirst: true,
    pitchFormula: pitchFormulaB(130, 0x1900),
    questionRiseOffset: 0xc80,
  },
};

/** 各 voice 数据表的惰性加载器(首次使用才 import 对应文件)。 */
export const VOICE_LOADERS: Record<VoiceName, () => Promise<VoiceTables>> = {
  f1: () => import("./data/aquespeak_data_f1.js"),
  f2: () => import("./data/aquespeak_data_f2.js"),
  r1: () => import("./data/aquespeak_data_r1.js"),
  m1: () => import("./data/aquespeak_data_m1.js"),
  m2: () => import("./data/aquespeak_data_m2.js"),
  dvd: () => import("./data/aquespeak_data_dvd.js"),
  jgr: () => import("./data/aquespeak_data_jgr.js"),
  imd1: () => import("./data/aquespeak_data_imd1.js"),
};
