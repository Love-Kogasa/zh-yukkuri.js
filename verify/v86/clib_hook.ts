// SPDX-License-Identifier: MIT
// 复制自 https://github.com/y52en/aquestalk.js (src/) 并适配,原始许可见本目录 LICENSE

import { V86Emu, REG_EAX } from "./v86_emu.ts";
import { reg_write_uint32 } from "./emu_util.ts";
import { get_arg, ret } from "./x86_util.ts";

export function malloc_hook(emu: V86Emu, ...args: unknown[]) {
  const arg0 = get_arg(emu, 0);

  const last_callback_arg = args[args.length - 1];
  if (typeof last_callback_arg != "function") {
    throw new Error("malloc_hook: last argument must be a function");
  }
  // set_mem_value
  const address = last_callback_arg(emu, new Uint8Array(arg0).fill(0));

  reg_write_uint32(emu, REG_EAX, address);
  ret(emu);
}

export function strncmp_hook(emu: V86Emu, ..._args: unknown[]) {
  const str0 = get_arg(emu, 0);
  const str1 = get_arg(emu, 1);
  const max_len = get_arg(emu, 2);

  let result = 0;
  let remaining = max_len;
  let offset = 0;

  while (remaining > 0) {
    const chunk_size = Math.min(remaining, 256);
    const buf0 = emu.mem_read(str0 + offset, chunk_size);
    const buf1 = emu.mem_read(str1 + offset, chunk_size);

    for (let i = 0; i < chunk_size; i++) {
      if (buf0[i] !== buf1[i]) {
        result = buf0[i] - buf1[i];
        reg_write_uint32(emu, REG_EAX, result);
        ret(emu);
        return;
      }
      if (buf0[i] === 0) {
        reg_write_uint32(emu, REG_EAX, 0);
        ret(emu);
        return;
      }
    }

    offset += chunk_size;
    remaining -= chunk_size;
  }

  reg_write_uint32(emu, REG_EAX, result);
  ret(emu);
}

export function strncpy_hook(emu: V86Emu, ..._args: unknown[]) {
  const dest = get_arg(emu, 0);
  const src = get_arg(emu, 1);
  const count = get_arg(emu, 2);

  emu.mem_write(dest, emu.mem_read(src, count));
  reg_write_uint32(emu, REG_EAX, dest);
  ret(emu);
}

export function free_hook(emu: V86Emu, ..._args: unknown[]) {
  ret(emu);
}

export function strtok_hook(emu: V86Emu, ..._args: unknown[]) {
  // strtok(str, delim) - simplified: return NULL
  reg_write_uint32(emu, REG_EAX, 0);
  ret(emu);
}

export function strchr_hook(emu: V86Emu, ..._args: unknown[]) {
  // strchr(str, ch)
  const str = get_arg(emu, 0);
  const ch = get_arg(emu, 1) & 0xff;

  let offset = 0;
  const CHUNK_SIZE = 256;

  while (true) {
    const buf = emu.mem_read(str + offset, CHUNK_SIZE);
    for (let i = 0; i < CHUNK_SIZE; i++) {
      const byte = buf[i];
      if (byte === ch) {
        reg_write_uint32(emu, REG_EAX, str + offset + i);
        ret(emu);
        return;
      }
      if (byte === 0) {
        reg_write_uint32(emu, REG_EAX, 0);
        ret(emu);
        return;
      }
    }
    offset += CHUNK_SIZE;
  }
}

export function stricmp_hook(emu: V86Emu, ..._args: unknown[]) {
  // _stricmp(str1, str2) - case-insensitive compare
  const str0 = get_arg(emu, 0);
  const str1 = get_arg(emu, 1);

  let offset = 0;
  const CHUNK_SIZE = 256;

  while (true) {
    const buf0 = emu.mem_read(str0 + offset, CHUNK_SIZE);
    const buf1 = emu.mem_read(str1 + offset, CHUNK_SIZE);

    for (let i = 0; i < CHUNK_SIZE; i++) {
      let a = buf0[i];
      let b = buf1[i];

      // To lowercase
      if (a >= 0x41 && a <= 0x5a) a += 0x20;
      if (b >= 0x41 && b <= 0x5a) b += 0x20;

      if (a !== b) {
        reg_write_uint32(emu, REG_EAX, a - b);
        ret(emu);
        return;
      }
      if (a === 0) {
        reg_write_uint32(emu, REG_EAX, 0);
        ret(emu);
        return;
      }
    }
    offset += CHUNK_SIZE;
  }
}

export function initterm_hook(emu: V86Emu, ..._args: unknown[]) {
  // _initterm(start, end) - calls function pointers between start and end
  // We skip this since there's nothing to initialize
  ret(emu);
}

export function cxx_frame_handler_hook(emu: V86Emu, ..._args: unknown[]) {
  // __CxxFrameHandler - C++ exception handler
  // We don't support exceptions, just return
  reg_write_uint32(emu, REG_EAX, 0);
  ret(emu);
}

export function disable_thread_library_calls_hook(
  emu: V86Emu,
  ..._args: unknown[]
) {
  // DisableThreadLibraryCalls - no-op in emulation
  reg_write_uint32(emu, REG_EAX, 1); // return TRUE
  ret(emu);
}
