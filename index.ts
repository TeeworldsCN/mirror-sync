import { getBucketMap, getBucketMapFromBucket, upload } from './libs/storage';
import { listDDNetMaps } from './libs/ddnet';
import { generateBadges, generateIndex } from './libs/indexing';
import os from 'os';

require('dotenv').config();

process.env.TZ = 'Asia/Shanghai';

const MAX_WORKERS = os.cpus().length;

(async () => {
  let bucketMaps: { [key: string]: { date: number; size: number } } = {};
  try {
    bucketMaps = await getBucketMapFromBucket();
  } catch (e) {
    console.log("can't get bucket map cache. collecting from bucket...");
    bucketMaps = await getBucketMap();
  }

  const missingMaps = await listDDNetMaps(bucketMaps);

  if (missingMaps.length == 0) {
    console.log('No new maps found.');
    return;
  }

  console.log(`Found ${missingMaps.length} maps. Processing...`);

  // create a custom worker pool
  const pool: Worker[] = [];
  const callbacks: Map<
    number,
    (result: { success: boolean; reason?: string; size?: number; date?: number }) => void
  > = new Map();

  for (let i = 0; i < MAX_WORKERS; i++) {
    const worker = new Worker('./libs/workers/map-worker.ts');
    pool.push(worker);
    worker.onmessage = (event: MessageEvent) => {
      const { id, success, reason, size, date } = event.data;
      const cb = callbacks.get(id);
      if (cb) {
        callbacks.delete(id);
        cb({ success, reason, size, date });
      }
    };
  }

  const jobs: Promise<void>[] = [];

  for (let i = 0; i < missingMaps.length; i++) {
    const workerIndex = i % MAX_WORKERS;
    const worker = pool[workerIndex];
    const map = missingMaps[i];

    jobs.push(
      new Promise((resolve, reject) => {
        const cb = (result: {
          success: boolean;
          reason?: string;
          size?: number;
          date?: number;
        }) => {
          if (result.success) {
            bucketMaps[map] = {
              date: result.date,
              size: result.size,
            };
            console.log(` - ${map} uploaded`);
          } else {
            reject(new Error(`Failed to upload ${map}: ${result.reason}`));
          }
          resolve();
        };
        callbacks.set(i, cb);
        worker.postMessage({ map, id: i });
      })
    );
  }

  try {
    await Promise.all(jobs);

    console.log('Upload finished');
    console.log('Generating index');

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

    for (let worker of pool) {
      worker.terminate();
    }
    console.log('Done');
  } catch (e) {
    console.error(e);
    for (let worker of pool) {
      worker.terminate();
    }
    return;
  }
})();
