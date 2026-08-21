// SPDX-License-Identifier: MIT
// 复制自 https://github.com/y52en/aquestalk.js (src/) 并适配,原始许可见本目录 LICENSE

export interface PEResult {
  baseAddress: number;
  aquesTalkSyntheRVA: number;
  iatHooks: { [key: string]: { rva: number; target: number } };
  adjustFdivRVA: number;
  adjustFdivTarget: number;
}

export function parsePE(buffer: ArrayBuffer): PEResult {
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // DOS Header: "MZ" at 0x0
  if (view.getUint16(0, true) !== 0x5a4d) {
    throw new Error("Not a PE file (MZ header missing)");
  }

  // PE Header offset at 0x3c
  const peOffset = view.getUint32(0x3c, true);
  // PE Signature: "PE\0\0"
  if (view.getUint32(peOffset, true) !== 0x00004550) {
    throw new Error("Not a PE file (PE signature missing)");
  }

  const machine = view.getUint16(peOffset + 4, true);
  if (machine !== 0x014c) {
    // IMAGE_FILE_MACHINE_I386
    throw new Error("Only x86-32 PE files are supported");
  }

  const numberOfSections = view.getUint16(peOffset + 6, true);
  const sizeOfOptionalHeader = view.getUint16(peOffset + 20, true);
  const optionalHeaderOffset = peOffset + 24;

  const magic = view.getUint16(optionalHeaderOffset, true);
  if (magic !== 0x010b) {
    // PE32
    throw new Error("Only PE32 (32-bit) is supported");
  }

  const imageBase = view.getUint32(optionalHeaderOffset + 28, true);

  // Data Directories
  const dataDirectoryOffset = optionalHeaderOffset + 96;
  const exportDirRVA = view.getUint32(dataDirectoryOffset, true);
  const importDirRVA = view.getUint32(dataDirectoryOffset + 8, true);

  // Section Headers
  const sectionHeadersOffset = optionalHeaderOffset + sizeOfOptionalHeader;
  const sections: {
    name: string;
    virtualAddress: number;
    virtualSize: number;
    pointerToRawData: number;
  }[] = [];

  for (let i = 0; i < numberOfSections; i++) {
    const offset = sectionHeadersOffset + i * 40;
    const nameBytes = uint8.slice(offset, offset + 8);
    const name = new TextDecoder()
      .decode(nameBytes)
      .replace(/\0/g, "")
      .trim();
    sections.push({
      name,
      virtualAddress: view.getUint32(offset + 12, true),
      virtualSize: view.getUint32(offset + 8, true),
      pointerToRawData: view.getUint32(offset + 20, true),
    });
  }

  function rvaToOffset(rva: number): number {
    for (const section of sections) {
      if (
        rva >= section.virtualAddress &&
        rva < section.virtualAddress + section.virtualSize
      ) {
        return section.pointerToRawData + (rva - section.virtualAddress);
      }
    }
    return rva; // Fallback if no section matches, though unlikely for valid RVA
  }

  // Find AquesTalk_Synthe in Export Table
  let aquesTalkSyntheRVA = 0;
  if (exportDirRVA !== 0) {
    const exportOffset = rvaToOffset(exportDirRVA);
    const numNames = view.getUint32(exportOffset + 24, true);
    const addressOfFunctions = view.getUint32(exportOffset + 28, true);
    const addressOfNames = view.getUint32(exportOffset + 32, true);
    const addressOfNameOrdinals = view.getUint32(exportOffset + 36, true);

    const namesOffset = rvaToOffset(addressOfNames);
    const ordinalsOffset = rvaToOffset(addressOfNameOrdinals);
    const functionsOffset = rvaToOffset(addressOfFunctions);

    for (let i = 0; i < numNames; i++) {
      const nameRVA = view.getUint32(namesOffset + i * 4, true);
      const nameOffset = rvaToOffset(nameRVA);
      let name = "";
      for (let j = nameOffset; uint8[j] !== 0; j++) {
        name += String.fromCharCode(uint8[j]);
      }

      if (name === "AquesTalk_Synthe") {
        const ordinal = view.getUint16(ordinalsOffset + i * 2, true);
        aquesTalkSyntheRVA = view.getUint32(functionsOffset + ordinal * 4, true);
        break;
      }
    }
  }

  // Find IAT hooks and _adjust_fdiv
  const iatHooks: { [key: string]: { rva: number; target: number } } = {};
  let adjustFdivRVA = 0;
  let adjustFdivTarget = 0;

  if (importDirRVA !== 0) {
    let importOffset = rvaToOffset(importDirRVA);
    while (true) {
      const nameRVA = view.getUint32(importOffset + 12, true);
      if (nameRVA === 0) break;

      const firstThunkRVA = view.getUint32(importOffset + 16, true);
      const originalFirstThunkRVA = view.getUint32(importOffset, true) || firstThunkRVA;
      
      if (firstThunkRVA === 0) break;

      const thunkOffset = rvaToOffset(originalFirstThunkRVA);
      const iatOffset = rvaToOffset(firstThunkRVA);
      let entryIndex = 0;

      while (entryIndex < 1000) { // Safety limit
        const thunkValue = view.getUint32(thunkOffset + entryIndex * 4, true);
        if (thunkValue === 0) break;

        const currentIATRVA = firstThunkRVA + entryIndex * 4;
        const currentTargetRVA = view.getUint32(iatOffset + entryIndex * 4, true);

        if ((thunkValue & 0x80000000) === 0) {
          // Import by name
          const nameDataOffset = rvaToOffset(thunkValue);
          let funcName = "";
          for (let j = nameDataOffset + 2; uint8[j] !== 0; j++) {
            funcName += String.fromCharCode(uint8[j]);
          }

          if (
            [
              "malloc",
              "free",
              "strncmp",
              "strncpy",
              "strtok",
              "strchr",
              "stricmp",
              "_initterm",
              "__CxxFrameHandler",
              "DisableThreadLibraryCalls",
            ].includes(funcName) ||
            funcName === "_adjust_fdiv"
          ) {
            iatHooks[funcName] = { rva: currentIATRVA, target: currentTargetRVA };
          }
          if (funcName === "_adjust_fdiv") {
            adjustFdivRVA = currentIATRVA;
            adjustFdivTarget = currentTargetRVA;
          }
        }
        entryIndex++;
      }
      importOffset += 20;
    }
  }

  return {
    baseAddress: imageBase,
    aquesTalkSyntheRVA,
    iatHooks,
    adjustFdivRVA,
    adjustFdivTarget,
  };
}
