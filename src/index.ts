import axios from 'axios';
import COS from 'cos-nodejs-sdk-v5';
import fs from 'fs';
import pb from 'pretty-bytes';
import crypto from 'crypto';
import { crc32 } from 'crc';
import { makeBadge } from 'badge-maker';

require('dotenv').config();

process.env.TZ = 'Asia/Shanghai';

const tmpPath = process.env.TMP_PATH || './tmp';

// How many concurrent downloads
const DOWNLOAD_BATCH_SIZE = 5;
// How many maps allowed in the temp folder
const PROCESS_BATCH_SIZE = 20;

const checkFile = (file: string) => {
  try {
    const data = fs.readFileSync(file);
    const hash = file.match(/(?:(?:_([0-9a-z]{8}))|(?:_([0-9a-z]{64})))\.map/);
    if (hash[2]) {
      const actual = crypto.createHash('sha256').update(data).digest('hex');
      const expected = hash[2];
      if (actual == expected) {
        return { valid: true };
      } else {
        return { valid: false, reason: `hash mismatch, expected ${expected}, actual ${actual}` };
      }
    }

    if (hash[1]) {
      const actual = crc32(data).toString(16).padStart(8, '0');
      const expected = hash[1];
      if (actual == expected) {
        return { valid: true };
      } else {
        return { valid: false, reason: `crc mismatch, expected ${expected}, actual ${actual}` };
      }
    }
    return { valid: false, reason: 'hash not found in filename' };
  } catch {
    return { valid: false, reason: 'file error' };
  }
};

let cos = new COS({
  SecretId: process.env.COS_SECRET,
  SecretKey: process.env.COS_SECRET_KEY,
});

const downloadPool = new Map<string, Promise<void>>();
const downloadingPool = new Set();

const download = async (map: any) => {
  downloadingPool.add(map);
  const response = await axios.get(`https://maps.ddnet.org/${encodeURIComponent(map)}`, {
    responseType: 'stream',
  });

  const path = `${tmpPath}/${map}`;
  response.data.pipe(fs.createWriteStream(path));

  return new Promise<void>((resolve, reject) => {
    response.data.on('end', () => {
      downloadingPool.delete(map);
      resolve();
    });

    response.data.on('error', () => {
      downloadingPool.delete(map);
      reject();
    });
  });
};

const startDownload = async (map: any) => {
  const downloadPromise = download(map);
  downloadPool.set(map, downloadPromise);
  return downloadPromise;
};

const waitForDownload = async (map: any) => {
  const downloadPromise = downloadPool.get(map);
  if (downloadPromise) {
    await downloadPromise;
    downloadPool.delete(map);
  }
};

const getBucket = async () => {
  const bucketMaps: { [key: string]: { date: string; size: number } } = {};
  let marker: string = undefined;
  let total = 0;
  while (true) {
    const bucket = await cos.getBucket({
      Bucket: process.env.COS_MAP_BUCKET,
      Region: process.env.COS_REGION,
      Marker: marker,
      MaxKeys: 1000,
    });

    for (let item of bucket.Contents) {
      if (!item.Key.endsWith('.map')) continue;
      bucketMaps[item.Key] = {
        date: item.LastModified,
        size: parseInt(item.Size),
      };
    }

    total += bucket.Contents.length;
    console.log(` - Bucket contains ${total} items`);
    marker = bucket.NextMarker;
    if (bucket.IsTruncated == 'false') {
      break;
    }
  }
  return bucketMaps;
};

type SourceJob = (bucketMaps: {
  [key: string]: { date: string; size: number };
}) => Promise<string[]>;

const getMapsFromHttp: SourceJob = async bucketMaps => {
  const mapSource = await axios.get('http://maps.ddnet.org', {
    headers: {
      'Accept-Encoding': 'gzip, deflate, br',
    },
    responseType: 'text',
    decompress: true,
    timeout: 60000,
  });

  const missingMaps: string[] = [];
  const maps = mapSource.data.match(/<a href="(.*.map)">/g);
  if (maps) {
    for (let map of maps) {
      const filename = decodeURIComponent(map.match(/<a href="(.*.map)">/)[1]);
      if (!filename || !filename.endsWith('.map')) continue;
      if (!(filename in bucketMaps)) {
        missingMaps.push(filename);
      }
    }
  }

  return missingMaps;
};

const generateIndex = async (bucketMaps: { [key: string]: { date: string; size: number } }) => {
  const list: [string, (typeof bucketMaps)[0]][] = [];
  for (let key in bucketMaps) {
    list.push([key, bucketMaps[key]]);
  }

  list.sort(([_a, a], [_b, b]) => (a.date == b.date ? 0 : a.date > b.date ? -1 : 1));

  let site = '<html><head><meta charset="utf-8" /><title>DDNet地图镜像</title></head><body>';
  site += `<h1>DDNet地图镜像</h1><p>上次同步时间: ${new Date().toLocaleString(
    'zh-CN'
  )}</p><hr><pre>`;
  for (let [file, data] of list) {
    const name = file.slice(0, 50);
    const size = pb(data.size);
    site += `<a href="${encodeURIComponent(file)}">${name}</a>`;
    site += `${''.padEnd(51 - name.length)}${data.date.slice(0, 10)}${size.padStart(14)}<br>`;
  }
  site += '</pre></body><html>';

  fs.writeFileSync(`${tmpPath}/index.html`, site);
  console.log('Uploading Index');
  try {
    await cos.sliceUploadFile({
      Bucket: process.env.COS_MAP_BUCKET,
      Region: process.env.COS_REGION,
      Key: 'index.html',
      FilePath: `${tmpPath}/index.html`,
    });
    console.log(' - Index Uploaded');
  } catch (e) {
    console.error(' - Index Upload failed');
    console.error(e);
  }
};

const generateBadges = async (bucketMaps: { [key: string]: { date: string; size: number } }) => {
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

  fs.writeFileSync(`${tmpPath}/last-sync.svg`, lastSyncBadge);
  fs.writeFileSync(`${tmpPath}/sync-count.svg`, syncCountBadge);

  try {
    await cos.sliceUploadFile({
      Bucket: process.env.COS_MAP_BUCKET,
      Region: process.env.COS_REGION,
      Key: 'last-sync.svg',
      FilePath: `${tmpPath}/last-sync.svg`,
    });
    console.log(' - Last Sync Badge Uploaded');
  } catch (e) {
    console.error(' - Last Sync Badge Upload Failed');
    console.error(e);
  }

  try {
    await cos.sliceUploadFile({
      Bucket: process.env.COS_MAP_BUCKET,
      Region: process.env.COS_REGION,
      Key: 'sync-count.svg',
      FilePath: `${tmpPath}/sync-count.svg`,
    });
    console.log(' - Sync Count Badge Uploaded');
  } catch (e) {
    console.error(' - Sync Count Badge Upload Failed');
    console.error(e);
  }
};

const tryStartDownload = (maps: string[], index: number) => {
  while (
    index < maps.length &&
    downloadPool.size < PROCESS_BATCH_SIZE &&
    downloadingPool.size < DOWNLOAD_BATCH_SIZE
  ) {
    const map = maps[index++];
    startDownload(map);
  }
  return index;
};

const jobHttp = async () => {
  console.log('Getting bucket');
  const bucketMaps = await getBucket();

  console.log('Checking map source');
  const missingMaps = await getMapsFromHttp(bucketMaps);

  if (missingMaps.length > 0) {
    console.log(`Prepare to upload ${missingMaps.length} items`);

    let count = 1;
    let downloadIndex = 0;

    for (let i = 0; i < missingMaps.length; i++) {
      downloadIndex = tryStartDownload(missingMaps, downloadIndex);
      const map = missingMaps[i];
      console.log(`(${count++}/${missingMaps.length}) Processing map: ${map}`);
      process.stdout.write(' - downloading');
      try {
        await waitForDownload(map);
        process.stdout.write(' ok');
      } catch (e) {
        process.stdout.write(' failed');
        console.log('');
        console.error(` - Reason: ${e.message || 'unknown'}`);
        continue;
      }

      process.stdout.write(' | validating');
      const validationResult = checkFile(`${tmpPath}/${map}`);
      if (!validationResult?.valid) {
        process.stdout.write(' failed');
        console.log('');
        console.warn(` - Reason: ${validationResult.reason}`);
        continue;
      }
      process.stdout.write(' ok');

      process.stdout.write(' | uploading');
      try {
        const stat = fs.statSync(`${tmpPath}/${map}`);
        await cos.sliceUploadFile({
          Bucket: process.env.COS_MAP_BUCKET,
          Region: process.env.COS_REGION,
          Key: map,
          FilePath: `${tmpPath}/${map}`,
        });
        process.stdout.write(' ok');
        bucketMaps[map] = {
          date: new Date().toISOString(),
          size: stat.size,
        };
      } catch (e) {
        process.stdout.write(' failed');
        console.log('');
        console.error(` - Reason: ${e.message || 'unknown'}`);
        return;
      }

      process.stdout.write(' | cleaning up');
      try {
        fs.unlinkSync(`${tmpPath}/${map}`);
        process.stdout.write(' ok');
      } catch (e) {
        process.stdout.write(' failed');
        console.log('');
        console.error(` - Reason: ${e.message || 'unknown'}`);
        return;
      }
      console.log('');
    }
    console.log('Generateing index.html');
    await generateIndex(bucketMaps);
    console.log('Generateing badges');
    await generateBadges(bucketMaps);
  } else {  
    console.log('Nothing changed');
  }

  console.log('Sync finished');
  console.log('Job finished');
};

jobHttp()
  .catch(reason => {
    console.error('process failed');
    console.error(reason);
    process.exit(1);
  })
  .then(() => {
    console.log('Job quit');
    process.exit(0);
  });
