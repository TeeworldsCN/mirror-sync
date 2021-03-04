import axios from 'axios';
import cheerio from 'cheerio';
import COS from 'cos-nodejs-sdk-v5';
import fs from 'fs';
import pb from 'pretty-bytes';
import crypto from 'crypto';
import { crc32 } from 'crc';

const checkFile = (file: string) => {
  try {
    const data = fs.readFileSync(file);
    const hash = file.match(/(?:(?:_([0-9a-z]{8}))|(?:_([0-9a-z]{64})))\.map/);
    if (!hash[1] && !hash[2]) return false;
    if (hash[2]) {
      return crypto.createHash('sha256').update(data).digest('hex') == hash[2];
    }

    if (hash[1]) {
      return crc32(data).toString(16) == hash[1];
    }
    return false;
  } catch {
    return false;
  }
};

require('dotenv').config();

let cos = new COS({
  SecretId: process.env.COS_SECRET,
  SecretKey: process.env.COS_SECRET_KEY,
});

const download = async (map: any) => {
  const response = await axios.get(`https://maps.ddnet.tw/${map.link}`, {
    responseType: 'stream',
  });

  const path = `${process.env.TWCN_TMP_PATH}/${map.filename}`;
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
}) => Promise<{ link: string; filename: string }[]>;

const getMapsFromHttp: SourceJob = async bucketMaps => {
  const mapSource = await axios.get('http://maps.ddnet.tw', { timeout: 60000 });

  const missingMaps: { link: string; filename: string }[] = [];
  const $ = cheerio.load(mapSource.data);
  $('a').each((_, link) => {
    const href = $(link).attr('href');
    let filename;

    try {
      filename = decodeURIComponent(href);
    } catch {
      console.log(`ignoring: ${href}`);
      return;
    }

    if (!filename || !filename.endsWith('.map')) return;

    if (!(filename in bucketMaps)) {
      missingMaps.push({ link: href, filename });
    }
  });

  return missingMaps;
};

const getMapsFromFileSystem: SourceJob = async bucketMaps => {
  const mapSource = fs.readdirSync(process.env.TWCN_MAP_SOURCE_PATH);
  const missingMaps: { link: string; filename: string }[] = [];
  for (let filename of mapSource) {
    if (!filename || !filename.endsWith('.map')) continue;

    if (!(filename in bucketMaps)) {
      missingMaps.push({ link: encodeURIComponent(filename), filename });
    }
  }

  return missingMaps;
};

const generateIndex = async (bucketMaps: { [key: string]: { date: string; size: number } }) => {
  const list: [string, typeof bucketMaps[0]][] = [];
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

  fs.writeFileSync(`${process.env.TWCN_TMP_PATH}/index.html`, site);
  console.log('Uploading Index');
  try {
    await cos.sliceUploadFile({
      Bucket: process.env.COS_MAP_BUCKET,
      Region: process.env.COS_REGION,
      Key: 'index.html',
      FilePath: `${process.env.TWCN_TMP_PATH}/index.html`,
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
      console.log(`Downloading map: ${map.filename}`);
      try {
        await download(map);
        console.log(' - Downloaded');
      } catch (e) {
        console.error(' - Download failed');
        console.error(e);
        continue;
      }

      console.log(' - Validating');
      if (!checkFile(`${process.env.TWCN_TMP_PATH}/${map.filename}`)) {
        console.warn(` - Map ${map.filename} can not be validated`);
        continue;
      }

      try {
        const stat = fs.statSync(`${process.env.TWCN_TMP_PATH}/${map.filename}`);
        await cos.sliceUploadFile({
          Bucket: process.env.COS_MAP_BUCKET,
          Region: process.env.COS_REGION,
          Key: map.filename,
          FilePath: `${process.env.TWCN_TMP_PATH}/${map.filename}`,
        });
        console.log(' - Uploaded');
        bucketMaps[map.filename] = {
          date: new Date().toISOString(),
          size: stat.size,
        };
      } catch (e) {
        console.error(' - Upload failed');
        console.error(e);
        return;
      }
    }
  } else {
    console.log('Nothing changed');
  }

  console.log('Sync finished');
  console.log('Cleaning temp files');

  for (let map of missingMaps) {
    try {
      fs.unlinkSync(`${process.env.TWCN_TMP_PATH}/${map.filename}`);
    } catch {
      console.warn(` - Failed to remove file ${map.filename}`);
    }
  }

  console.log('Generateing index.html');
  await generateIndex(bucketMaps);

  console.log('Job finished');
};

const jobFs = async () => {
  console.log('Getting bucket');
  const bucketMaps = await getBucket();

  console.log('Checking map source');
  const missingMaps = await getMapsFromFileSystem(bucketMaps);

  if (missingMaps.length > 0) {
    console.log(`Prepare to upload ${missingMaps.length} items`);

    for (let map of missingMaps) {
      console.log(` - Validating map: ${map.filename}`);
      if (!checkFile(`${process.env.TWCN_MAP_SOURCE_PATH}/${map.filename}`)) {
        console.warn(` - Map ${map.filename} can not be validated`);
        continue;
      }

      try {
        const stat = fs.statSync(`${process.env.TWCN_MAP_SOURCE_PATH}/${map.filename}`);
        await cos.sliceUploadFile({
          Bucket: process.env.COS_MAP_BUCKET,
          Region: process.env.COS_REGION,
          Key: map.filename,
          FilePath: `${process.env.TWCN_MAP_SOURCE_PATH}/${map.filename}`,
        });
        console.log(' - Uploaded');
        bucketMaps[map.filename] = {
          date: new Date().toISOString(),
          size: stat.size,
        };
      } catch (e) {
        console.error(' - Upload failed');
        console.error(e);
        return;
      }
    }
  } else {
    console.log('Nothing changed');
  }

  console.log('Sync finished');

  console.log('Generateing index.html');
  await generateIndex(bucketMaps);

  console.log('Job finished');
};

jobFs()
  .catch(reason => {
    console.error('process failed');
    console.error(reason);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
    console.log('Job quit');
  });
