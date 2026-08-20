/**
 * FIR 系数推导(LPC 递归 + 前后向合并)—— 与原版逐字节一致,
 * 全部 voice 共用。
 */
import { imul32 } from "../core/types.js";

/**
 * LPC 递归的一级旋转:原版把一个 16.16 定点复数打包进一个 int32
 * (`v`:低半 = 实部,高半 = 虚部),按反射系数 `f` 旋转:
 *   A = (re_even * f >> 14) & ~3 ; B = -(im * f) << 2 ; out = B - A + carry
 */
function lpcStageRotate(v: number, reflection: number, carry: number): number {
  let reTerm = imul32(v & 0xfffe, reflection);
  reTerm = (reTerm >> 14) & -4;
  let imTerm = -imul32(v >> 16, reflection);
  imTerm = (imTerm << 2) | 0;
  return (imTerm - reTerm + carry) | 0;
}

/**
 * 对一张 11 字的音素参数表跑 5 级复旋转链(反射系数在偶数下标
 * 0..8),返回 6 个梯级输出(int32)。六个累加寄存器与原版反汇编
 * 一一对应。
 */
export function lpcTransform(params: Int16Array): Int32Array {
  const out = new Int32Array(6);
  const unit = 0x1000000; // 贯穿整条链的定点"1"
  let carrier = -((params[0] << 16) >> 16) * 1024; // -t0 << 10
  const f2 = (params[2] << 16) >> 16;
  const f4 = (params[4] << 16) >> 16;
  const f6 = (params[6] << 16) >> 16;
  const f8 = (params[8] << 16) >> 16;

  let a = (unit << 1) | 0; // 0x2000000
  let s0 = 0, s1 = 0, s2 = 0;

  a = lpcStageRotate(carrier, f2, a);
  carrier = (carrier - ((f2 << 10) | 0)) | 0;
  s0 = (carrier << 1) | 0;
  s0 = lpcStageRotate(a, f4, s0);
  a = (a + unit) | 0;
  a = lpcStageRotate(carrier, f4, a);
  carrier = (carrier - ((f4 << 10) | 0)) | 0;
  s1 = (a << 1) | 0;
  s1 = lpcStageRotate(s0, f6, s1);
  s0 = (s0 + carrier) | 0;
  s0 = lpcStageRotate(a, f6, s0);
  a = (a + unit) | 0;
  a = lpcStageRotate(carrier, f6, a);
  carrier = (carrier - ((f6 << 10) | 0)) | 0;
  s2 = (s0 << 1) | 0;
  s2 = lpcStageRotate(s1, f8, s2);
  s1 = (s1 + a) | 0;
  s1 = lpcStageRotate(s0, f8, s1);
  s0 = (s0 + carrier) | 0;
  s0 = lpcStageRotate(a, f8, s0);
  a = (a + unit) | 0;
  a = lpcStageRotate(carrier, f8, a);
  carrier = (carrier - ((f8 << 10) | 0)) | 0;

  out[0] = unit;
  out[1] = carrier;
  out[2] = a;
  out[3] = s0;
  out[4] = s1;
  out[5] = s2;
  return out;
}

/**
 * 合并两次 lpcTransform(音素原表 + 右移一字后的表):
 * A 跑前缀和、B 跑前缀差,再按 ± 配对、bit-12 舍入、截到 16 位。
 */
export function lpcMerge(g1: Int32Array, g2: Int32Array): number[] {
  const a = Array.from(g1);
  const b = Array.from(g2);
  a[5] += a[4]; b[5] -= b[4];
  a[4] += a[3]; b[4] -= b[3];
  a[3] += a[2]; b[3] -= b[2];
  a[2] += a[1]; b[2] -= b[1];
  a[1] += a[0]; b[1] -= b[0];
  const round13 = (v: number): number => {
    let o = v >> 13;
    if (v & 0x1000) o += 1; // 低字的 bit 12(即 0x1000)
    return o & 0xffff;
  };
  const out: number[] = [0x1000];
  for (let k = 1; k <= 5; k++) out.push(round13(a[k] + b[k]));
  for (let k = 5; k >= 1; k--) out.push(round13(a[k] - b[k]));
  return out;
}

/** 由一张音素参数表得到 FIR 系数(11 × i16)。 */
export function firCoefficients(params: Int16Array): Int16Array {
  const g1 = lpcTransform(params);
  const shifted = new Int16Array(11);
  for (let i = 0; i < 10; i++) shifted[i] = params[i + 1];
  const g2 = lpcTransform(shifted);
  return new Int16Array(lpcMerge(g1, g2));
}
