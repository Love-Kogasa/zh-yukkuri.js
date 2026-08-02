export async function load(path) {
  var blob = await (await fetch(path)).blob()
  return URL.createObjectURL(blob)
}

export function loadList(list) {
  return Promise.all(list.map(path => (async () => [path, await load(path)])()))
}