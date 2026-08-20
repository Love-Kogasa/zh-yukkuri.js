/**
 * 合成对象的共享缓冲区(一块 0x6800 字节的内存)—— "跨短语残留"
 * 机制的显式内存模型,整个引擎最精妙也最反直觉的一块。
 *
 * 背景:原版引擎把**两类完全不同的记录**先后写进同一块缓冲区:
 *
 *   解析阶段 → 分词队列   每条 { 0xAB 魔数, N, 重音, 类型, 系数 } 6 字节
 *                          + 每音节 4 字节 { 音高, 名字 id }
 *   渲染阶段 → 帧记录     每帧一条变长记录(6/8/10 字节,见 serializeFrames)
 *
 * 两个阶段都**从不清零内存,只把游标拨回开头**。于是:
 * 短语 N+1 里若某个分词以促音(っ)收尾,促音展开时会越过自己分词的
 * 音节数组继续读 4 个字节——那里躺着的是短语 N 留下的帧记录。
 * 这读出来的"幻影后继"会被当作下一个假名照常展开。
 * 这不是 bug,而是原版引擎的既定行为(决定了哪些输入报 102、哪些
 * "碰巧"能出声);我们用同一块缓冲区 + 同两个写入者忠实复刻它。
 *
 * 字段序注意:分词队列条目里两个 16 位字段的顺序因 voice 而异——
 * f1 是 { 名字@+0, 音高@+2 },其余 7 个 voice 相反。残留读取必须按
 * 对应的字段序取 id 和 f0,否则幻影后继就"解错了行"。
 */
import type { PhraseToken, FrameMeta, SynthesisFrame } from "./types.js";

export const ARENA_SIZE = 0x6800;

/** 分词队列条目的字段序(按 voice)。 */
export interface TokenArenaLayout {
  /**
   * true = { 音高字 @+0, 名字 @+2 }(非 f1 的 7 个 voice);
   * false(f1)= { 名字 @+0, 音高字 @+2 }。
   */
  wordFirst: boolean;
}

export class SynthArena {
  readonly bytes = new Uint8Array(ARENA_SIZE);

  constructor(layout: TokenArenaLayout) {
    this.layout = layout;
  }
  private readonly layout: TokenArenaLayout;

  private w16(off: number, v: number): void {
    this.bytes[off] = v & 0xff;
    this.bytes[off + 1] = (v >>> 8) & 0xff;
  }

  // --------------------------------------------------------------------------
  // 解析阶段的写入者:分词队列
  // --------------------------------------------------------------------------

  /**
   * 把本短语的分词队列写到缓冲区开头(游标复位——原版引擎正是复用
   * 缓冲区头部;队列之后的旧字节原样留存,成为残留)。
   * 条目布局:6 字节头 { 0xAB, N, 重音, 类型, 系数u16 } + 每音节 4 字节,
   * 两个 16 位字段按 voice 的字段序排列。
   * 返回队列总字节长度 = Σ (6 + 4·N)。
   */
  writeTokenQueue(tokens: PhraseToken[]): number {
    let off = 0;
    for (const t of tokens) {
      this.bytes[off] = 0xab;
      this.bytes[off + 1] = t.N & 0xff;
      this.bytes[off + 2] = t.acc & 0xff;
      this.bytes[off + 3] = t.type & 0xff;
      this.w16(off + 4, t.coef & 0xffff);
      off += 6;
      for (let i = 0; i < t.N; i++) {
        const f0 = t.f0[i] & 0xffff;
        // 音节的假名 id 放在名字半区(与原版缓冲区逐字节核对过),
        // 另一半区是 f0;先后顺序由字段序决定
        if (this.layout.wordFirst) {
          this.w16(off, f0);
          this.w16(off + 2, t.ids[i] & 0xffff);
        } else {
          this.w16(off, t.ids[i] & 0xffff);
          this.w16(off + 2, f0);
        }
        off += 4;
      }
    }
    return off;
  }

  /**
   * 分词末尾促音的残留读取:把 `off`(刚越过队列末尾)处的 4 个字节
   * 按本 voice 的字段序解出一个幻影后继 { id, f0 }。
   */
  readStaleEntry(off: number): { id: number; f0: number } {
    const r16 = (p: number) => this.bytes[p] | (this.bytes[p + 1] << 8);
    return this.layout.wordFirst
      ? { id: this.bytes[off + 2], f0: r16(off) }
      : { id: this.bytes[off], f0: r16(off + 2) };
  }

  // --------------------------------------------------------------------------
  // 渲染阶段的写入者:帧记录(变长序列化)
  // --------------------------------------------------------------------------

  /**
   * 逐帧追加记录,游标从 0 开始(原版引擎每短语把帧游标拨回 0;
   * 记录再次覆盖缓冲区头部,尾部留作下一短语的残留)。
   * 记录按"能省则省"的原则选四种长度之一:
   *   type0 {0, w, 增益, 周期}          6 字节 —— 槽位对与上一条完全相同
   *   type1 {1, w, 增益, 周期, from}    8 字节 —— 上一条的 to == 本条 to(链式)
   *   type2 {2, 0, 增益, 周期, to}      8 字节 —— 本条 to == from(静止)
   *   type3 {3, w, 增益, 周期, to, from} 10 字节 —— 其余情况
   */
  serializeFrames(frames: SynthesisFrame[], meta: FrameMeta[]): void {
    let cursor = 0;
    let prevP5 = -1; // 上一条记录的两个槽位,初值为哨兵 0xffff
    let prevP6 = -1;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const m = meta[i];
      const p2word = (m.flags | (f.pulsePeriod & 0x3fff)) & 0xffff;
      // 第三个字段是"增益字"(噪声增益 | 脉冲增益<<8),不是 FIR 系数——
      // 渲染时会从槽位对重新推导 FIR
      const gainWord = ((f.pulseGain & 0xff) << 8) | (f.noiseGain & 0xff);
      const p5 = m.p5 & 0xffff;
      const p6 = m.p6 & 0xffff;
      if (cursor + 10 > ARENA_SIZE) return; // 写满即止(与原版一致)
      let type: number;
      let len: number;
      if (prevP5 === p5 && prevP6 === p6) {
        type = 0;
        len = 6;
      } else if (prevP6 === p5) {
        type = 1;
        len = 8;
      } else if (p5 === p6) {
        type = 2;
        len = 8;
      } else {
        type = 3;
        len = 10;
      }
      this.bytes[cursor] = type;
      this.bytes[cursor + 1] = type === 2 ? 0 : m.weight & 0xff;
      this.w16(cursor + 2, gainWord);
      this.w16(cursor + 4, p2word);
      if (len >= 8) this.w16(cursor + 6, type === 1 ? p6 : p5);
      if (len === 10) this.w16(cursor + 8, p6);
      cursor += len;
      prevP5 = p5;
      prevP6 = p6;
    }
  }
}
