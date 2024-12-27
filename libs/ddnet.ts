export const listDDNetMaps = async (exclude?: { [key: string]: any }) => {
  if (!exclude) exclude = {};

  const mapSource = await fetch('http://maps.ddnet.org', {
    headers: {
      'accept-encoding': 'gzip, deflate, br',
    },
    signal: AbortSignal.timeout(60000),
  });

  if (!mapSource.ok) {
    throw new Error(`Failed to fetch maps.ddnet.org: ${mapSource.statusText}`);
  }

  const page = await mapSource.text();

  const list: string[] = [];
  const maps = page.match(/<a href="(.*.map)">/g);
  if (maps) {
    for (let map of maps) {
      const filename = decodeURIComponent(map.match(/<a href="(.*.map)">/)[1]);
      if (!filename || !filename.endsWith('.map')) continue;
      if (!(filename in exclude)) {
        list.push(filename);
      }
    }
  }

  return list;
};

export const downloadDDNetMap = async (map: any): Promise<Buffer> => {
  const response = await fetch(`https://maps.ddnet.org/${encodeURIComponent(map)}`);

  if (!response.ok) {
    throw new Error(`Failed to download map: ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
};
