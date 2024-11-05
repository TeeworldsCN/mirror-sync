import axios from 'axios';
import COS from 'cos-nodejs-sdk-v5';
import fs from 'fs';
import pb from 'pretty-bytes';
import crypto from 'crypto';
import { crc32 } from 'crc';

require('dotenv').config();

process.env.TZ = 'Asia/Shanghai';

const tmpPath = process.env.TMP_PATH || './tmp';

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

const download = async (map: any) => {
  const response = await axios.get(`https://maps.ddnet.org/${encodeURIComponent(map)}`, {
    responseType: 'stream',
  });

  const path = `${tmpPath}/${map}`;
  console.log(` - Downloading to ${path}`);
  response.data.pipe(fs.createWriteStream(path));

  return new Promise<void>((resolve, reject) => {
    response.data.on('end', () => {
      resolve();
    });

    response.data.on('error', () => {
      reject();
    });
  });
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
  site += `<h1>DDNet地图镜像</h1><p>上次同步时间: ${new Date().toLocaleString()}</p><hr><pre>`;
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

const jobHttp = async () => {
  console.log('Getting bucket');
  const bucketMaps = await getBucket();

  console.log('Checking map source');
  const missingMaps = await getMapsFromHttp(bucketMaps);

  if (missingMaps.length > 0) {
    console.log(`Prepare to upload ${missingMaps.length} items`);

    for (let map of missingMaps) {
      console.log(`Downloading map: ${map}`);
      try {
        await download(map);
        console.log(' - Downloaded');
      } catch (e) {
        console.error(' - Download failed');
        console.error(e);
        continue;
      }

      console.log(' - Validating');
      const validationResult = checkFile(`${tmpPath}/${map}`);
      if (!validationResult?.valid) {
        console.warn(` - Map ${map} can not be validated:\n     ${validationResult.reason}`);
        continue;
      }

      try {
        const stat = fs.statSync(`${tmpPath}/${map}`);
        await cos.sliceUploadFile({
          Bucket: process.env.COS_MAP_BUCKET,
          Region: process.env.COS_REGION,
          Key: map,
          FilePath: `${tmpPath}/${map}`,
        });
        console.log(' - Uploaded');
        bucketMaps[map] = {
          date: new Date().toISOString(),
          size: stat.size,
        };
      } catch (e) {
        console.error(' - Upload failed');
        console.error(e);
        return;
      }

      try {
        fs.unlinkSync(`${tmpPath}/${map}`);
      } catch {
        console.warn(` - Failed to remove file ${map}`);
      }
    }
    console.log('Generateing index.html');
    await generateIndex(bucketMaps);
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
    process.exit(0);
    console.log('Job quit');
  });
