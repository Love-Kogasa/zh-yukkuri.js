/**
 * 第五级 —— 音素缓冲条目 → 合成帧序列:
 *   BODY 稳态帧 + 相邻主体间自动过渡;ONSET/LEAD 的增益塑形(比值表);
 *   TRANSITION 滑音;TAIL 沿音高表的衰减释放。
 */
import type { FrameMeta, SynthesisFrame, Voice } from "../core/types.js";
import { PhonemeKind, dividePow2Rounded, interpolateFixed8, interpolateParams } from "../core/types.js";
import { expandPhonemes, type PhraseContext } from "./expand.js";
import { firCoefficients } from "../render/filter.js";

/** 语速 → 帧率控制字(floor(0x6400/speed),下限 0x200)。 */
export function frameRateControl(speed: number): number {
  return speed < 50 ? 0x200 : Math.floor(0x6400 / Math.min(speed, 300));
}

/** 目录查找失败的哨兵(上层捕获后转为错误 102)。 */
export const SOKUON_LOOKUP_FAIL = Symbol("sokuon-lookup-fail-102");

export function buildFrames(
  seq: number[],
  speed: number,
  voice: Voice,
  ctx: PhraseContext,
  moraPitches?: number[],
  metaOut?: FrameMeta[],
): SynthesisFrame[] {
  const { PHONEME_PARAMS: PP, F0TABLE, TABLE_13D30: T } = voice.tables;
  const f0ctrl = frameRateControl(speed);
  const frames: SynthesisFrame[] = [];
  // 每帧样本数由音高字高两位的尺寸标志决定:
  //   无标志 40 / bit14 50 / bit15 60 / 双标志 70
  const samples40 = dividePow2Rounded(f0ctrl * 0x28, 8);
  const samples50 = dividePow2Rounded(f0ctrl * 5 * 0x28, 10);
  const samples60 = dividePow2Rounded(f0ctrl * 0xf0, 10);
  const samples70 = dividePow2Rounded(f0ctrl * 7 * 0x28, 10);
  const samplesFor = (flags: number): number =>
    flags === 0 ? samples40 : flags === 0x4000 ? samples50 : flags === 0x8000 ? samples60 : samples70;

  const phs = expandPhonemes(seq, voice, ctx, moraPitches);
  let prevSlot = 0; // 跨音素传递的槽位
  // 从第一个音素自身的音高起笔,保证起始平直
  let prevPeriod = phs.length > 0 ? phs[0].pitchWord & 0x3fff : 0;
  let prevGains: [number, number] = [0, 0]; // [噪声增益, 脉冲增益]

  for (let pi = 0; pi < phs.length; pi++) {
    const ph = phs[pi];
    if (ph.invalid) throw SOKUON_LOOKUP_FAIL; // 目录查不到 → 102
    const sizeFlags = ph.pitchWord & 0xc000;
    const sampleCount = samplesFor(sizeFlags);
    const ownPeriod = ph.pitchWord & 0x3fff;
    // ONSET/LEAD 要对着它们所引出的那个 CV 的槽位渲染
    const nextPh = phs[pi + 1];
    const baseSlot =
      (ph.kind === PhonemeKind.ONSET || ph.kind === PhonemeKind.LEAD) && nextPh
        ? nextPh.slot
        : ph.slot;

    if (ph.kind === PhonemeKind.BODY) {
      for (let k = 0; k < ph.frameCount; k++) {
        const slot = baseSlot + k;
        const tbl = PP[slot];
        if (!tbl) continue;
        // 增益从上一槽位的第 10 字取种子
        const gainWord = (PP[slot - 1]?.[10] ?? 0) & 0xffff;
        const w = Math.floor((k * 256) / ph.frameCount);
        frames.push({
          sampleCount,
          pulsePeriod: interpolateFixed8(prevPeriod, ownPeriod, w),
          noiseGain: gainWord & 0xff,
          pulseGain: (gainWord >> 8) & 0xff,
          firCoefficients: firCoefficients(tbl),
        });
        metaOut?.push({ p5: slot, p6: slot, weight: 0, flags: sizeFlags });
        prevSlot = slot;
        prevGains = [gainWord & 0xff, (gainWord >> 8) & 0xff];
      }
      prevPeriod = ownPeriod;
      // 相邻 BODY 间的自动过渡:向"下一主体槽位 + 帧数/3"插值,
      // 每 44 个槽位一帧
      if (nextPh && nextPh.kind === PhonemeKind.BODY) {
        const transTarget = nextPh.slot + Math.floor(nextPh.frameCount / 3);
        const transCount = Math.floor((transTarget - prevSlot) / 44);
        if (transCount > 0) {
          const tblA = PP[prevSlot];
          const tblB = PP[transTarget];
          if (tblA && tblB) {
            for (let k = 0; k < transCount; k++) {
              const w = Math.floor((k * 256) / transCount);
              frames.push({
                sampleCount: samples40,
                pulsePeriod: ownPeriod,
                noiseGain: prevGains[0],
                pulseGain: prevGains[1],
                firCoefficients: firCoefficients(interpolateParams(tblA, tblB, w)),
              });
              metaOut?.push({ p5: transTarget, p6: prevSlot, weight: w, flags: 0 });
            }
          }
        }
      }
    } else if (ph.kind === PhonemeKind.TRANSITION) {
      // 从"上一槽位/增益/音高"滑向本音素自身的值
      const targetWord = (PP[ph.slot - 1]?.[10] ?? 0) & 0xffff;
      const targetGains: [number, number] = [targetWord & 0xff, (targetWord >> 8) & 0xff];
      const fromSlot = prevSlot;
      const fromPeriod = prevPeriod;
      const fromGains = prevGains;
      for (let k = 0; k < ph.frameCount; k++) {
        const w = Math.floor((k * 256) / ph.frameCount);
        const tblA = PP[fromSlot];
        const tblB = PP[ph.slot];
        if (!tblA || !tblB) continue;
        frames.push({
          sampleCount,
          pulsePeriod: interpolateFixed8(fromPeriod, ownPeriod, w),
          noiseGain: interpolateFixed8(fromGains[0], targetGains[0], w) & 0xff,
          pulseGain: interpolateFixed8(fromGains[1], targetGains[1], w) & 0xff,
          firCoefficients: firCoefficients(interpolateParams(tblA, tblB, w)),
        });
        // 序列化记录的槽位对顺序是 (p5=from, p6=to)——与 ONSET 分支
        // 相反;经字节级探针确认。只影响记录字节,不影响 PCM
        // (JS 渲染直接消费帧,不读记录)
        metaOut?.push({ p5: fromSlot, p6: ph.slot, weight: w, flags: sizeFlags });
      }
      prevSlot = ph.slot;
      prevPeriod = ownPeriod;
      prevGains = targetGains;
    } else if (ph.kind === PhonemeKind.TAIL) {
      // 释放:槽位固定,增益沿 F0TABLE 曲线衰减
      const tbl = PP[prevSlot];
      if (!tbl) continue;
      const baseFir = firCoefficients(tbl);
      const d0 = F0TABLE[ph.slot] & 0xff;
      const d1 = (F0TABLE[ph.slot] >> 8) & 0xff;
      for (let k = 0; k < ph.frameCount; k++) {
        const w = Math.floor((k * 256) / ph.frameCount);
        const b0 = F0TABLE[ph.slot + k] & 0xff;
        const b1 = (F0TABLE[ph.slot + k] >> 8) & 0xff;
        frames.push({
          sampleCount,
          pulsePeriod: interpolateFixed8(prevPeriod, ownPeriod, w),
          noiseGain: d0 === 0 ? 0 : Math.floor((prevGains[0] * b0) / d0) & 0xff,
          pulseGain: d1 === 0 ? 0 : Math.floor((prevGains[1] * b1) / d1) & 0xff,
          firCoefficients: new Int16Array(baseFir),
        });
        metaOut?.push({ p5: prevSlot, p6: prevSlot, weight: 0, flags: sizeFlags });
      }
      prevPeriod = ownPeriod;
    } else {
      // ONSET / LEAD:CV 主体之前的辅音塑形
      const isSilenceLead = ph.kind === PhonemeKind.LEAD && (ph.name === ";k" || ph.name === ";v");
      // k/g/b/q 起音与非静默引子用乘法比值表
      const useRatio =
        (ph.kind === PhonemeKind.LEAD && !isSilenceLead) ||
        (ph.kind === PhonemeKind.ONSET && "kgbq".includes(ph.name[1]));
      const slotOffset = ph.kind === PhonemeKind.ONSET && useRatio ? 4 : 0;
      // 渐变目标槽位:后继是 BODY → 槽位+偏移;TRANSITION → 槽位
      // (偏移被忽略);其他 → 0。+4 只对 BODY 后继生效
      // (`あっい` 实测 +q 滑向 PP[i.slot] 而非 i.slot+4)
      const toSlot = !nextPh
        ? prevSlot
        : nextPh.kind === PhonemeKind.BODY
          ? nextPh.slot + slotOffset
          : nextPh.kind === PhonemeKind.TRANSITION
            ? nextPh.slot
            : 0;
      const useInterp = ph.kind === PhonemeKind.ONSET && prevSlot !== toSlot;

      // 目标增益取"下一个主体"的第 10 字
      const nextSlot = nextPh ? nextPh.slot : prevSlot;
      const nextWord = (PP[nextSlot - 1]?.[10] ?? 0) & 0xffff;
      const nextGains: [number, number] = [nextWord & 0xff, (nextWord >> 8) & 0xff];
      const ratioPrevGains = prevGains; // 进循环时冻结

      for (let k = 0; k < ph.frameCount; k++) {
        const w = Math.floor((k * 256) / ph.frameCount);
        const tblA = PP[prevSlot];
        const tblB = PP[toSlot];
        if (!tblA || !tblB) continue;
        const tbl = useInterp ? interpolateParams(tblA, tblB, w) : tblB;
        let noiseGain: number, pulseGain: number;
        if (isSilenceLead) {
          // ";k" / ";v" 送气引子:静默激励
          noiseGain = 0;
          pulseGain = 0;
        } else if (ph.kind === PhonemeKind.LEAD) {
          // 引子比值:向下一主体的种子增益靠拢
          const baseWord =
            nextPh && nextPh.kind === PhonemeKind.BODY
              ? (PP[nextPh.slot - 1]?.[10] ?? 0) & 0xffff
              : (T[nextPh ? nextPh.slot : prevSlot] ?? 0);
          const end = T[ph.slot + ph.frameCount - 1] ?? 0;
          const cur = T[ph.slot + k] ?? 0;
          noiseGain =
            (end & 0xff) === 0 ? 0 : Math.trunc(((baseWord & 0xff) * (cur & 0xff)) / (end & 0xff)) & 0xff;
          pulseGain =
            ((end >> 8) & 0xff) === 0
              ? 0
              : Math.trunc((((baseWord >> 8) & 0xff) * ((cur >> 8) & 0xff)) / ((end >> 8) & 0xff)) & 0xff;
        } else if (useRatio) {
          // 起音比值:当前增益 × 比值表值 / 比值表基
          const base = T[ph.slot] ?? 0;
          const cur = T[ph.slot + k] ?? 0;
          noiseGain =
            (base & 0xff) === 0
              ? 0
              : Math.trunc((ratioPrevGains[0] * (cur & 0xff)) / (base & 0xff)) & 0xff;
          pulseGain =
            ((base >> 8) & 0xff) === 0
              ? 0
              : Math.trunc((ratioPrevGains[1] * ((cur >> 8) & 0xff)) / ((base >> 8) & 0xff)) & 0xff;
        } else {
          // 其余起音:自适应插值塑形
          const sM1 = T[ph.slot + ph.frameCount - 1] ?? 0;
          const s0 = T[ph.slot] ?? 0;
          const sK = T[ph.slot + k] ?? 0;
          const shape = (prev: number, next: number, m1: number, z0: number, zk: number): number => {
            if (z0 !== m1) {
              const ratio = Math.trunc(((next - prev) * 0x400) / (m1 - z0));
              if (ratio >= 0 && ratio < 0x1001) {
                const val = dividePow2Rounded((zk - z0) * ratio, 10) + prev;
                return (val < 1 ? 0 : val) & 0xff;
              }
            }
            return (prev + Math.trunc(((next - prev) * k) / ph.frameCount)) & 0xff;
          };
          noiseGain = shape(ratioPrevGains[0], nextGains[0], sM1 & 0xff, s0 & 0xff, sK & 0xff);
          pulseGain = shape(
            ratioPrevGains[1], nextGains[1], (sM1 >> 8) & 0xff, (s0 >> 8) & 0xff, (sK >> 8) & 0xff,
          );
        }
        frames.push({
          sampleCount,
          pulsePeriod: interpolateFixed8(prevPeriod, ownPeriod, w),
          noiseGain,
          pulseGain,
          firCoefficients: firCoefficients(tbl),
        });
        // 序列化记录的槽位对:两个起音分支都是 (p5=prev, p6=toSlot)
        // —— 与 TRANSITION 分支相反,经字节级探针确认;只影响记录
        // 字节不影响 PCM。
        // LEAD 的记录是 (toSlot, toSlot)(渲染阶段对 p2word 标志位的
        // 突变未建模,属已知的开放项)。
        metaOut?.push(
          ph.kind === PhonemeKind.LEAD
            ? { p5: toSlot, p6: toSlot, weight: 0, flags: sizeFlags }
            : { p5: prevSlot, p6: toSlot, weight: w, flags: sizeFlags },
        );
        if (!useRatio && !isSilenceLead) prevGains = [noiseGain, pulseGain];
      }
      if (frames.length > 0) {
        const last = frames[frames.length - 1];
        prevGains = [last.noiseGain, last.pulseGain];
      }
      prevSlot = toSlot;
      prevPeriod = ownPeriod;
    }
  }
  return frames;
}
