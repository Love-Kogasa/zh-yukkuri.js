/**
 * 帧渲染器:噪声源 + 窗函数脉冲振荡器 + 10 阶 FIR,A/B 两个渲染族。
 *
 * 渲染状态是**短语级**的 —— 原版每渲染一个短语就重建一次渲染对象,
 * 这里通过"每次调用全新分配状态"来等价实现,这正是短语独立性的来源。
 */
import type { SynthesisFrame, Voice } from "../core/types.js";
import { imul32, dividePow2Rounded } from "../core/types.js";

/** 把帧序列渲染成 16 位 PCM(8 kHz 单声道)。 */
export function renderFrames(frames: SynthesisFrame[], voice: Voice): Int16Array {
  const { WAVE4096: noiseTable, WINDOW: pulseWindow } = voice.tables;
  const {
    noiseTableLength,
    pulseWindowThreshold,
    renderFamily,
    renderModulation,
  } = voice.constants;

  // 噪声通道状态
  let noisePhase = 0;
  // 脉冲振荡器状态(4 个重叠槽位)
  let pulsePhase = 0;
  let pulseWriteIdx = 0;
  const pulseIdx = new Int16Array([pulseWindowThreshold, pulseWindowThreshold, pulseWindowThreshold, pulseWindowThreshold]);
  const pulseAmp = new Int16Array(4);
  // FIR 环形历史缓冲(10 个历史样本)
  const history = new Int16Array(10);
  let writeIdx = 0; // 从 9 递减到 0 回绕
  // B 族附加状态
  let modCounter = 0;
  let envelope = 0;
  let agcGain = 0x400;

  const out: number[] = [];

  for (const f of frames) {
    if (renderFamily === "B") {
      // 每帧更新 AGC 增益:包络很小时用固定增益,否则反比于包络
      agcGain = envelope < 0x800 ? 0xc00 : Math.trunc(0x400000 / envelope) + 0x400;
    }
    for (let n = 0; n < f.sampleCount; n++) {
      // 噪声:波表值 × 增益 / 128,相位在表长处回绕
      if (noisePhase >= noiseTableLength) noisePhase = 0;
      const noise = dividePow2Rounded(imul32(noiseTable[noisePhase], f.noiseGain), 7);
      noisePhase = (noisePhase + 1) & 0xffff;

      // 脉冲串:窗函数整形幅度,每个周期开一个新槽位
      let pulse = 0;
      for (let i = 0; i < 4; i++) {
        if (pulseIdx[i] < pulseWindowThreshold) {
          pulse = (pulse + dividePow2Rounded(imul32(pulseWindow[pulseIdx[i]], pulseAmp[i]), 7)) | 0;
          pulseIdx[i] = (pulseIdx[i] + 8) & 0xffff;
        }
      }
      pulsePhase = (pulsePhase + 8) & 0xffff;
      if (pulsePhase >= f.pulsePeriod) {
        pulsePhase -= f.pulsePeriod;
        pulseAmp[pulseWriteIdx] = f.pulseGain;
        pulseIdx[pulseWriteIdx] = pulsePhase;
        pulseWriteIdx = (pulseWriteIdx + 1) & 3;
      }

      let sample = (noise + pulse) | 0;

      if (renderFamily === "B" && renderModulation === "negate16") {
        // dvd:每 16 个样本把前 8 个取反
        if (modCounter < 8) sample = -sample;
        modCounter++;
        if (modCounter >= 0x10) modCounter = 0;
      } else if (renderFamily === "B") {
        // jgr:每 8 个样本把第 1 个置零
        if (modCounter === 0) sample = 0;
        modCounter++;
        if (modCounter >= 8) modCounter = 0;
      }

      // 10 阶 FIR(环形缓冲按 writeIdx 分成两段累加)
      const w = writeIdx;
      let acc = imul32(f.firCoefficients[0], sample);
      for (let m = 0; m <= w; m++) {
        acc = (acc - imul32(f.firCoefficients[10 - w + m], history[m])) | 0;
      }
      for (let m = w + 1; m < 10; m++) {
        acc = (acc - imul32(f.firCoefficients[m - w], history[m])) | 0;
      }
      let value: number;
      if (acc >= 0x7ffffff) value = 0x7fff;
      else if (acc <= -0x7ffffff) value = 0xffff8000;
      else value = (acc + 0x800) >> 12; // +0x800 实现四舍五入
      value &= 0xffff;
      history[writeIdx] = value & 0xffff;
      writeIdx = writeIdx === 0 ? 9 : writeIdx - 1;
      let pcm = (value << 16) >> 16;

      if (renderFamily === "B") {
        // 包络跟踪 + AGC 缩放 + 限幅
        envelope = envelope - (envelope >> 5);
        const rectified = pcm >> 5;
        envelope = pcm > 0 ? envelope + rectified : envelope - rectified;
        const scaled = Math.trunc((agcGain * pcm) / 1024);
        if (scaled > 0x7fff) pcm = 0x7fff;
        else if (scaled < -0x8000) pcm = -0x8000;
        else pcm = scaled;
      }
      out.push(pcm);
    }
  }
  return new Int16Array(out);
}

/** 把 PCM16 样本包上 44 字节的 RIFF/WAVE 头(8 kHz 单声道)。 */
export function wavBytes(pcm: Int16Array): Uint8Array {
  const dataLen = pcm.length * 2;
  const wav = new Uint8Array(44 + dataLen);
  const dv = new DataView(wav.buffer);
  dv.setUint32(0, 0x46464952, true); // "RIFF"
  dv.setUint32(4, 36 + dataLen, true);
  dv.setUint32(8, 0x45564157, true); // "WAVE"
  dv.setUint32(12, 0x20746d66, true); // "fmt "
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // 单声道
  dv.setUint32(24, 8000, true);
  dv.setUint32(28, 16000, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  dv.setUint32(36, 0x61746164, true); // "data"
  dv.setUint32(40, dataLen, true);
  for (let i = 0; i < pcm.length; i++) {
    dv.setInt16(44 + i * 2, pcm[i], true);
  }
  return wav;
}
