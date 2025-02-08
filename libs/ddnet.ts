export const listDDNetMaps = async (exclude?: { [key: string]: any }) => {
  if (!exclude) exclude = {};

  const mapSource = await fetch('https://maps.ddnet.org', {
    headers: {
      'accept-encoding': 'gzip, deflate, br',
    },
    signal: AbortSignal.timeout(60000),
  });

  if (!mapSource.ok) {
    throw new Error(`Failed to fetch maps.ddnet.org: ${mapSource.statusText}`);
  }

  const maps: string[] = [];

  const rewriter = new HTMLRewriter().on('a', {
    element(a) {
      const href = a.getAttribute('href');
      if (href && href.endsWith('.map')) {
        const filename = decodeURIComponent(href);
        if (!filename.endsWith('.map')) return;
        if (!(filename in exclude)) {
          maps.push(filename);
        }
      }
    }
  });

  rewriter.transform(await mapSource.text());
  return maps;
};

export const downloadDDNetMap = async (map: any): Promise<Buffer> => {
  const response = await fetch(`https://maps.ddnet.org/${encodeURIComponent(map)}`);

  if (!response.ok) {
    throw new Error(`Failed to download map: ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
};
