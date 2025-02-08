import { listDDNetMaps } from './libs/ddnet';
import { generateBadges, generateIndex } from './libs/indexing';
import { deleteFile, getBucketMap, upload } from './libs/storage';

process.env.TZ = 'Asia/Shanghai';

(async () => {
  const mapsInBucket = await getBucketMap();
  const ddnetMaps = new Set(await listDDNetMaps());
  for (let key in mapsInBucket) {
    if (!ddnetMaps.has(key)) {
      console.log(` - deleting ${key} ...`);
      await deleteFile(key);
    }
  }

  console.log('Regenerating index');
  const bucketMaps = await getBucketMap();

  await Promise.all([
    (async () => {
      const index = generateIndex(bucketMaps);
      await upload('index.html', index);
    })(),
    (async () => {
      const badges = generateBadges(bucketMaps);
      await upload('last-sync.svg', badges.lastSyncBadge);
      await upload('sync-count.svg', badges.syncCountBadge);
    })(),
    (async () => {
      await upload('maps.json', JSON.stringify(bucketMaps));
    })(),
  ]);
  console.log('Done');
})();
