import { makeBadge } from 'badge-maker';
import pb from 'pretty-bytes';

export const generateIndex = (bucketMaps: { [key: string]: { date: number; size: number } }) => {
  const list: [string, (typeof bucketMaps)[0]][] = [];

  for (let key in bucketMaps) {
    list.push([key, bucketMaps[key]]);
  }

  list.sort(([_a, a], [_b, b]) => b.date - a.date);

  let site = '<html><head><meta charset="utf-8" /><title>DDNet地图镜像</title></head><body>';
  site += `<h1>DDNet地图镜像</h1><p>上次同步时间: ${new Date().toLocaleString(
    'zh-CN'
  )}</p><hr><pre>`;

  for (let [file, data] of list) {
    const name = file.slice(0, 50);
    const size = pb(data.size);
    site += `<a href="${encodeURIComponent(file)}">${name}</a>`;
    site += `${''.padEnd(51 - name.length)}${new Date(data.date).toLocaleDateString(
      'zh-CN'
    )}${size.padStart(14)}<br>`;
  }
  site += '</pre></body><html>';

  return site;
};

export const generateBadges = (bucketMaps: { [key: string]: { date: number; size: number } }) => {
  const lastSyncBadge = makeBadge({
    label: '上次同步',
    message: new Date().toLocaleString('zh-CN'),
    color: 'blue',
  });
  const syncCountBadge = makeBadge({
    label: '已同步',
    message: `${Object.keys(bucketMaps).length} 张地图`,
    color: 'lightgrey',
  });

  return { lastSyncBadge, syncCountBadge };
};
