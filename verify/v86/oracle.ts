/**
 * v86 oracle —— 在 Node 里用 v86 模拟器加载**原版 DLL**,作为引擎的对比参照。
 *
 * 这是 verify.mts 的 DLL 侧实现:每次合成前重置 DLL 内存与堆 = 冷启动语义
 * (全新进程的确定行为)。v86 输出与真机 DLL 的等价性已在开发阶段做过
 * 全量交叉复核(详见仓库 README 的验证声明)。
 *
 * 前置(均为 gitignore 的自取资源,放 verify/assets/):
 *   v86.wasm                     —— v86 模拟器的 wasm 内核
 *   {voice}.zip                  —— 原版 voice 包(zip 内含 AquesTalk.dll)
 * 运行时依赖:npm 包 v86 与 jszip(devDependencies)。
 */
import JSZip from "jszip"
import { V86Emu, REG_EAX, REG_ESP } from "./v86_emu.ts"
import { call, push } from "./x86_util.ts"
import { from_bytes_uint32, to_bytes_uint32, uint8array_concat } from "./util.ts"
import { parsePE } from "./pe.ts"
import { Heap, NOP_CODE, hook_lib_call, reg_read_uint32, reg_write_uint32 } from "./emu_util.ts"
import { free_hook, malloc_hook } from "./clib_hook.ts"
import { NATIVE_CLIB_BIN, NATIVE_CLIB_SYMBOLS } from "./native_code.ts"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** 引擎的 kana→Shift-JIS 表(与 verify.mts 同源,零额外依赖)。 */ 
const { KANA_CHAR_TO_SJIS } = await import(
  pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/engine/pipeline/kana-map.ts")).href
)
const convert_sjis = (koe: string): Uint8Array => {
  const out: number[] = []
  for (const ch of koe) {
    const b = KANA_CHAR_TO_SJIS[ch]
    if (b) { out.push(...b); continue }
    const c = ch.codePointAt(0)!
    if (c > 0xff) throw new Error(`不可编码字符 "${ch}"(105 域)`)
    out.push(c)
  }
  return new Uint8Array(out)
}

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets")
const wasmPath = path.join(ASSETS, "v86.wasm")
const zipPath = (voice: string) => path.join(ASSETS, `${voice}.zip`)

/**
 * 合成一个输入并返回原始 WAV 字节(或抛出带错误码的异常)。
 * v86 实例按次新建(冷启动);1GB 模拟内存的初始化成本约数秒。
 */
export async function synthOnce(
  voice: string,
  koe: string,
  speed: number,
): Promise<Uint8Array> {
  const zip = new JSZip()
  const zipbin = await readFile(zipPath(voice))
  const root = await zip.loadAsync(zipbin)
  const dllFile = await root.files[`${voice}/AquesTalk.dll`].async("arraybuffer")

  const emu = new V86Emu()
  try {
    await emu.init({ wasmPath })

    const pe = parsePE(dllFile)
    const baseAddress = pe.baseAddress
    const synthe = baseAddress + pe.aquesTalkSyntheRVA
    const iatHooks = pe.iatHooks
    const adjustFdiv = pe.adjustFdivTarget

    emu.mem_write(baseAddress, new Uint8Array(dllFile))
    if (adjustFdiv) emu.mem_write(adjustFdiv, to_bytes_uint32(0))

    const HEAP_ADDRESS = 0x2000_0000
    const HEAP_LENGTH = 0x1000_0000
    const heap = new Heap(emu, HEAP_ADDRESS, HEAP_LENGTH)

    // malloc/free:这两个导入没有机器码实现,IAT 条目保持指向未链接地址,
    // 在该地址装 OUT 钩子转入 JS(堆分配器);否则 DLL 首次 malloc 就会
    // 跳进零填充内存死循环。
    for (const [name, info] of Object.entries(iatHooks)) {
      if (name === "malloc") {
        hook_lib_call(emu, info.target, malloc_hook, (emu: V86Emu, value: Uint8Array) => heap.set_mem_value(emu, value))
      } else if (name === "free") {
        hook_lib_call(emu, info.target, free_hook)
      }
    }

    const nativeAddr = heap.set_mem_value(emu, NATIVE_CLIB_BIN)
    for (const [name, offset] of Object.entries({
      strncmp: NATIVE_CLIB_SYMBOLS.strncmp,
      strncpy: NATIVE_CLIB_SYMBOLS.strncpy,
      strtok: NATIVE_CLIB_SYMBOLS.strtok,
      strchr: NATIVE_CLIB_SYMBOLS.strchr,
      stricmp: NATIVE_CLIB_SYMBOLS.stricmp,
      _stricmp: NATIVE_CLIB_SYMBOLS.stricmp,
      _initterm: NATIVE_CLIB_SYMBOLS._initterm,
      initterm: NATIVE_CLIB_SYMBOLS._initterm,
      __CxxFrameHandler: NATIVE_CLIB_SYMBOLS.__CxxFrameHandler,
      DisableThreadLibraryCalls: NATIVE_CLIB_SYMBOLS.DisableThreadLibraryCalls,
    })) {
      const info = iatHooks[name]
      if (info) emu.mem_write(baseAddress + info.rva, to_bytes_uint32(nativeAddr + offset))
    }

    const sizePtr = heap.set_mem_value(emu, new Uint8Array(8).fill(0))
    const koePtr = heap.set_mem_value(
      emu,
      uint8array_concat(convert_sjis(koe), new Uint8Array([0])),
    )
    const retPtr = heap.set_mem_value(emu, new Uint8Array(1048576).fill(NOP_CODE[0]))

    emu.reset_cpu()
    reg_write_uint32(emu, REG_ESP, HEAP_ADDRESS + HEAP_LENGTH)
    push(emu, sizePtr)
    push(emu, speed)
    push(emu, koePtr)
    emu.set_eip(retPtr)
    call(emu, synthe)
    await emu.emu_start(emu.get_eip(), retPtr)

    const size = from_bytes_uint32(emu.mem_read(sizePtr, 4))
    const resultPtr = reg_read_uint32(emu, REG_EAX)
    if (resultPtr === 0) {
      throw Object.assign(new Error(`AquesTalk_Synthe error ${size}`), { code: size })
    }
    return emu.mem_read(resultPtr, size)
  } finally {
    await emu.destroy()
  }
}
