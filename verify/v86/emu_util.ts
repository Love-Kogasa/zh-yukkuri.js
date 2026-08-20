// SPDX-License-Identifier: MIT
// 复制自 https://github.com/y52en/aquestalk.js (src/) 并适配,原始许可见本目录 LICENSE

import { V86Emu } from "./v86_emu.ts";


export class Heap {
  readonly heap_addr: number;
  readonly heap_len: number;
  heap_used = 0;

  constructor(emu: V86Emu, heap_addr: number, heap_len = 0) {
    this.heap_addr = heap_addr;
    this.heap_len = heap_len;
    // v86 has flat physical memory, no need to explicitly map
    // Just zero-fill the heap region
    emu.mem_write(heap_addr, new Uint8Array(heap_len));
  }

  set_mem_value(emu: V86Emu, value: Uint8Array): number {
    // Aligh to 4 bytes
    this.heap_used = (this.heap_used + 3) & ~3;
    const write_address = this.heap_addr + this.heap_used;
    if (write_address + value.length >= this.heap_addr + this.heap_len) {
      throw new Error("heap over");
    }
    emu.mem_write(write_address, value);
    this.heap_used += value.length;
    return write_address;
  }

  clear_heap(emu: V86Emu) {
    if (this.heap_used > 0) {
      emu.mem_write(this.heap_addr, new Uint8Array(this.heap_used));
      this.heap_used = 0;
    }
  }
}

export const NOP_CODE = new Uint8Array([0x90]);

export function hook_lib_call(
  emu: V86Emu,
  address: number,
  callback: (emu: V86Emu, ...args: any[]) => void,
  arg: any = null
) {
  emu.set_hook(address, (emu: V86Emu, userData: any) => {
    callback(emu, userData);
  }, arg);
}

export function reg_read_uint32(emu: V86Emu, reg: number): number {
  return emu.reg_read(reg);
}

export function reg_write_uint32(emu: V86Emu, reg: number, value: number) {
  emu.reg_write(reg, value);
}

export function align_to_0x1000(number: number): number {
  return Math.floor((number + 0xfff) / 0x1000) * 0x1000;
}
