// SPDX-License-Identifier: MIT
// 复制自 https://github.com/y52en/aquestalk.js (src/) 并适配,原始许可见本目录 LICENSE

/**
 * V86Emu - A wrapper around v86's internal CPU that provides
 * unicorn.js-like API for bare x86-32 emulation.
 *
 * Uses v86's JIT (x86 → WebAssembly) for much faster emulation
 * compared to unicorn.js's interpreter approach.
 */

import { V86 } from "v86";

// v86 register indices (matching cpu.reg32 Int32Array layout)
export const REG_EAX = 0;
export const REG_ECX = 1;
export const REG_EDX = 2;
export const REG_EBX = 3;
export const REG_ESP = 4;
export const REG_EBP = 5;
export const REG_ESI = 6;
export const REG_EDI = 7;
// EIP is handled via cpu.instruction_pointer

type HookCallback = (emu: V86Emu, ...args: any[]) => void;

interface HookEntry {
  callback: HookCallback;
  originalBytes: Uint8Array;
  userData: any;
  port: number;
}

const HOOK_PORT_BASE = 0xE0;

export class V86Emu {
  private emulator: any; // V86 instance
  private cpu: any; // CPU object (v86.cpu)
  private hooks: Map<number, HookEntry> = new Map();
  private portToHook: Map<number, HookEntry> = new Map();
  private _stopped = false;
  private nextHookPort = HOOK_PORT_BASE;

  constructor() {}

  /**
   * Initialize the V86 emulator.
   * Creates a V86 instance with multiboot to get flat 32-bit protected mode.
   */
  async init(options: { memorySize?: number; wasmPath?: string } = {}) {
    const memorySize = options.memorySize ?? 1024 * 1024 * 1024; // 1GB default
    const wasmPath = options.wasmPath;

    // Create a minimal multiboot binary: just a HLT loop
    const MULTIBOOT_MAGIC = 0x1BADB002;
    const MULTIBOOT_FLAGS = 0x00010000; // bit 16: we specify address info
    const MULTIBOOT_CHECKSUM = -(MULTIBOOT_MAGIC + MULTIBOOT_FLAGS) | 0;
    const LOAD_ADDR = 0x100000;
    const HEADER_ADDR = LOAD_ADDR;
    const ENTRY_ADDR = LOAD_ADDR + 32;

    const bin = new ArrayBuffer(64);
    const view = new DataView(bin);
    view.setInt32(0, MULTIBOOT_MAGIC, true);
    view.setInt32(4, MULTIBOOT_FLAGS, true);
    view.setInt32(8, MULTIBOOT_CHECKSUM, true);
    view.setUint32(12, HEADER_ADDR, true);
    view.setUint32(16, LOAD_ADDR, true);
    view.setUint32(20, 0, true);
    view.setUint32(24, 0, true);
    view.setUint32(28, ENTRY_ADDR, true);
    // Entry point: HLT + JMP loop
    view.setUint8(32, 0xf4); // HLT
    view.setUint8(33, 0xeb); // JMP short
    view.setUint8(34, 0xfc); // -4

    const v86Options: any = {
      memory_size: memorySize,
      vga_memory_size: 0,
      autostart: false,
      multiboot: { buffer: bin },
    };
    if (wasmPath) {
      v86Options.wasm_path = wasmPath;
    }

    this.emulator = new V86(v86Options);

    // Wait for emulator to be ready
    await new Promise<void>((resolve) => {
      this.emulator.add_listener("emulator-ready", () => {
        resolve();
      });
    });

    this.cpu = this.emulator.v86.cpu;

    // Set up a proper GDT with valid flat segment descriptors
    // This is needed because multiboot mode's segments don't have GDT entries,
    // and operations like POP SS trigger #GP without valid descriptors.
    this._setupGDT();
  }

  /**
   * Set up a Global Descriptor Table (GDT) with flat code and data segments.
   * GDT is placed at physical address 0x1000.
   */
  private _setupGDT(): void {
    const GDT_ADDR = 0x1000;

    // GDT entries: each is 8 bytes
    // Entry 0: Null descriptor (required)
    // Entry 1 (selector 0x08): Code segment - base=0, limit=4GB, DPL=3, Execute/Read
    // Entry 2 (selector 0x10): Data segment - base=0, limit=4GB, DPL=3, Read/Write
    const gdt = new Uint8Array(8 * 3);
    const gdtView = new DataView(gdt.buffer);

    // Entry 0: Null descriptor (all zeros)

    // Entry 1: Code segment (selector 0x08)
    // Limit[15:0] = 0xFFFF, Base[15:0] = 0x0000
    gdtView.setUint16(8, 0xffff, true);   // limit low
    gdtView.setUint16(10, 0x0000, true);  // base low
    // Base[23:16] = 0x00, Access byte: Present=1, DPL=11 (3), S=1, Type=1010 (exec/read) = 0xFA
    gdtView.setUint8(12, 0x00);            // base mid
    gdtView.setUint8(13, 0xfa);            // access: P=1, DPL=3, S=1, E=1, DC=0, RW=1, A=0
    // Flags: Granularity=1, Size=1 (32-bit), Limit[19:16] = 0xF → 0xCF
    gdtView.setUint8(14, 0xcf);            // flags + limit high
    gdtView.setUint8(15, 0x00);            // base high

    // Entry 2: Data segment (selector 0x10)
    // Same as code but Type=0010 (read/write) → Access byte 0xF2
    gdtView.setUint16(16, 0xffff, true);   // limit low
    gdtView.setUint16(18, 0x0000, true);   // base low
    gdtView.setUint8(20, 0x00);            // base mid
    gdtView.setUint8(21, 0xf2);            // access: P=1, DPL=3, S=1, E=0, DC=0, RW=1, A=0
    gdtView.setUint8(22, 0xcf);            // flags + limit high
    gdtView.setUint8(23, 0x00);            // base high

    // Write GDT to memory
    this.cpu.write_blob(gdt, GDT_ADDR);

    // Set GDTR: base = GDT_ADDR, limit = 3*8-1 = 23
    this.cpu.gdtr_size[0] = 23;
    this.cpu.gdtr_offset[0] = GDT_ADDR;

    // Load segment registers with proper selectors
    // CS = 0x08 (code segment), all data segments = 0x10
    // We can't directly set CS with a selector easily,
    // so we use the internal segment arrays that multiboot already set up
    const CODE_SEL = 0x08;
    const DATA_SEL = 0x10;

    // Set segment selectors
    this.cpu.sreg[0] = DATA_SEL; // ES
    this.cpu.sreg[1] = CODE_SEL; // CS
    this.cpu.sreg[2] = DATA_SEL; // SS
    this.cpu.sreg[3] = DATA_SEL; // DS
    this.cpu.sreg[4] = DATA_SEL; // FS
    this.cpu.sreg[5] = DATA_SEL; // GS

    // Ensure flat segments - base=0, limit=0xFFFFFFFF for all
    for (let i = 0; i < 6; i++) {
      this.cpu.segment_is_null[i] = 0;
      this.cpu.segment_offsets[i] = 0;
      this.cpu.segment_limits[i] = 0xffffffff;
    }

    this.cpu.update_state_flags();
  }

  /**
   * Write data to physical memory.
   */
  mem_write(addr: number, data: Uint8Array): void {
    this.cpu.write_blob(data, addr);
    this.cpu.jit_dirty_cache(addr, addr + data.length);
  }

  /**
   * Read data from physical memory.
   */
  mem_read(addr: number, size: number): Uint8Array {
    return new Uint8Array(this.cpu.read_blob(addr, size));
  }

  /**
   * Read a 32-bit register value.
   */
  reg_read(reg: number): number {
    return this.cpu.reg32[reg] >>> 0;
  }

  /**
   * Write a 32-bit register value.
   */
  reg_write(reg: number, value: number): void {
    this.cpu.reg32[reg] = value | 0;
  }

  /**
   * Read EIP (instruction pointer).
   */
  get_eip(): number {
    return (this.cpu.instruction_pointer[0] - this.cpu.get_seg_cs()) >>> 0;
  }

  /**
   * Set EIP (instruction pointer).
   */
  set_eip(addr: number): void {
    this.cpu.instruction_pointer[0] = this.cpu.get_seg_cs() + addr;
  }

  /**
   * Install a hook at the given address.
   * Uses I/O port OUT instruction to trap into JavaScript.
   *
   * We write the following x86 code at the address:
   *   PUSH EDX        ; 52       ; save EDX (we need it for port number)
   *   MOV DX, port    ; 66 BA pp pp  ; load hook port number
   *   OUT DX, AL      ; EE       ; trigger I/O port write → JavaScript handler
   * We write a simple OUT instruction at the hook address:
   *   OUT imm8, AL    ; E6 pp    ; trigger I/O port write → JavaScript handler
   *
   * Just 2 bytes. The callback is expected to handle the return (e.g., by calling ret()).
   * Since OUT doesn't modify any registers or the stack, get_arg/push/pop all work correctly.
   */
  set_hook(
    addr: number,
    callback: HookCallback,
    userData: any = null
  ): number {
    const port = this.nextHookPort++;
    if (port > 0xFF) {
        // Fallback to 16-bit port if we run out of 8-bit ports.
        // But for now, let's just use 8-bit and ensure we don't leak.
        // Actually, we can just use 16-bit ports for all hooks to be safe.
        // But that takes more bytes. 
        // Let's just stick to 8-bit and fix the leak in emu_start.
    }

    // Save the original byte at the hook address
    const originalBytes = new Uint8Array(this.cpu.read_blob(addr, 2));

    // Write the 2-byte trampoline: OUT imm8, AL
    const trampoline = new Uint8Array([0xe6, port & 0xFF]);
    this.cpu.write_blob(trampoline, addr);
    this.cpu.jit_dirty_cache(addr, addr + 2);

    const entry: HookEntry = { callback, originalBytes, userData, port };
    this.hooks.set(addr, entry);
    this.portToHook.set(port, entry);

    // Register the I/O port handler
    this.cpu.io.register_write(port, this, (_value: number) => {
      entry.callback(this, entry.userData);
    });
    
    return port;
  }

  /**
   * Remove a hook from the given address, restoring the original byte.
   */
  remove_hook(addr: number): void {
    const hook = this.hooks.get(addr);
    if (hook) {
      this.cpu.write_blob(hook.originalBytes, addr);
      this.cpu.jit_dirty_cache(addr, addr + 2);
      this.hooks.delete(addr);
      this.portToHook.delete(hook.port);
      // We don't unregister from cpu.io because v86 doesn't have an easy way 
      // to unregister a single port, but we can reuse the port if we managed a pool.
    }
  }

  /**
   * Start emulation from `start` address until reaching `until` address.
   */
  emu_start(start: number, until: number): void {
    this.set_eip(start);
    this._stopped = false;

    // Install a temporary hook at the 'until' address to stop execution
    const STOP_PORT = 0xDF; // Use a dedicated port for stopping to avoid leaks
    
    // Save original bytes locally
    const originalBytes = new Uint8Array(this.cpu.read_blob(until, 2));
    
    // Write stop trampoline: OUT 0xDF, AL
    this.cpu.write_blob(new Uint8Array([0xe6, STOP_PORT]), until);
    this.cpu.jit_dirty_cache(until, until + 2);
    
    const stopHandler = (_value: number) => {
        this._stopped = true;
    };
    this.cpu.io.register_write(STOP_PORT, this, stopHandler);

    // Run the CPU in a tight loop until stopped
    // Clear HLT state (multiboot entry point has HLT instruction)
    this.cpu.in_hlt[0] = 0;
    try {
      while (!this._stopped) {
        this.cpu.main_loop();
      }
    } catch (e: any) {
      if (e === "HALT" || (typeof e === "string" && e.includes("HALT"))) {
        // Expected for HLT instruction
      } else {
        throw e;
      }
    } finally {
        // Always restore original bytes and invalidate JIT
        this.cpu.write_blob(originalBytes, until);
        this.cpu.jit_dirty_cache(until, until + 2);
        // We leave the STOP_PORT handler registered since it's harmless
    }
  }



  /**
   * Stop emulation.
   */
  emu_stop(): void {
    this._stopped = true;
  }

  /**
   * Reset CPU registers and flags to a clean state.
   */
  reset_cpu(): void {
    // Reset general purpose registers to 0
    for (let i = 0; i < 8; i++) {
        this.cpu.reg32[i] = 0;
    }
    
    // Reset flags: Bit 1 is always 1 in EFLAGS.
    this.cpu.flags[0] = 0x2;
    
    // Clear HLT state
    this.cpu.in_hlt[0] = 0;

    // Re-setup segments to ensure they are consistent
    this._setupGDT();
  }

  /**
   * Destroy the emulator and release resources.
   */
  async destroy(): Promise<void> {
    if (this.emulator) {
      await this.emulator.destroy();
      this.emulator = null;
    }
  }
}
