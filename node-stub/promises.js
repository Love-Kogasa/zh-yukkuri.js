// node:fs/promises 的空桩
const stub = () => Promise.resolve(new Uint8Array(0));
stub.open = () => ({ close: async () => {}, read: async () => 0 });
stub.readFile = stub;
stub.writeFile = async () => {};
export default stub;
export const readFile = stub;
export const writeFile = async () => {};
export const open = stub.open;
