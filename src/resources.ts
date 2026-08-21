export async function load(path: string): Promise<string> {
  const blob = await (await fetch(path)).blob()
  return URL.createObjectURL(blob)
}

export function loadList(list: string[]): Promise<[string, string][]> {
  return Promise.all(list.map(path => (async () => [path, await load(path)])()))
}
