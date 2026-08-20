// SPDX-License-Identifier: MIT
// 复制自 https://github.com/y52en/aquestalk.js (src/) 并适配,原始许可见本目录 LICENSE

import { V86Emu, REG_ESP } from "./v86_emu.ts";
import { reg_read_uint32, reg_write_uint32 } from "./emu_util.ts";
import { from_bytes_uint32, to_bytes_uint32 } from "./util.ts";

export function push(emu: V86Emu, value: number) {
  reg_write_uint32(emu, REG_ESP, reg_read_uint32(emu, REG_ESP) - 4);
  emu.mem_write(reg_read_uint32(emu, REG_ESP), to_bytes_uint32(value));
}

export function pop(emu: V86Emu): number {
  const value = from_bytes_uint32(
    emu.mem_read(reg_read_uint32(emu, REG_ESP), 4)
  );
  reg_write_uint32(emu, REG_ESP, reg_read_uint32(emu, REG_ESP) + 4);
  return value;
}

export function jmp(emu: V86Emu, address: number) {
  emu.set_eip(address);
}

export function call(emu: V86Emu, address: number) {
  push(emu, emu.get_eip());
  jmp(emu, address);
}

export function ret(emu: V86Emu) {
  const ret_address = pop(emu);
  jmp(emu, ret_address);
}

export function get_arg(emu: V86Emu, num: number): number {
  return from_bytes_uint32(
    emu.mem_read(reg_read_uint32(emu, REG_ESP) + 4 * (1 + num), 4)
  );
}
