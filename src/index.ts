import axios from 'axios';
import cheerio from 'cheerio';
import COS from 'cos-nodejs-sdk-v5';
import fs from 'fs';
import pb from 'pretty-bytes';

require('dotenv').config();

let cos = new COS({
  SecretId: process.env.COS_SECRET,
  SecretKey: process.env.COS_SECRET_KEY,
});

const download = async (map: any) => {
  const response = await axios.get(`https://maps.ddnet.tw/${map.link}`, {
    responseType: 'stream',
  });

  const path = `${process.env.TWCN_SYNC_PATH}/${map.filename}`;
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

const job = async () => {
  console.log('Getting bucket');

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

  console.log('Getting map index');
  const mapSource = await axios.get('http://maps.ddnet.tw', { timeout: 60000 });

  const missingMaps: { link: string; filename: string }[] = [];

  let indexCount = 0;
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

    indexCount += 1;
    if (!(filename in bucketMaps)) {
      missingMaps.push({ link: href, filename });
    }
  });

  console.log(`Index contains ${indexCount} items`);

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

      try {
        const stat = fs.statSync(`${process.env.TWCN_SYNC_PATH}/${map.filename}`);
        await cos.sliceUploadFile({
          Bucket: process.env.COS_MAP_BUCKET,
          Region: process.env.COS_REGION,
          Key: map.filename,
          FilePath: `${process.env.TWCN_SYNC_PATH}/${map.filename}`,
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
      fs.unlinkSync(`${process.env.TWCN_SYNC_PATH}/${map.filename}`);
    } catch {
      console.warn(` - Failed to remove file ${map.filename}`);
    }
  }

  console.log('Generateing index.html');
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

  fs.writeFileSync(`${process.env.TWCN_SYNC_PATH}/index.html`, site);
  console.log('Uploading Index');
  try {
    await cos.sliceUploadFile({
      Bucket: process.env.COS_MAP_BUCKET,
      Region: process.env.COS_REGION,
      Key: 'index.html',
      FilePath: `${process.env.TWCN_SYNC_PATH}/index.html`,
    });
    console.log(' - Index Uploaded');
  } catch (e) {
    console.error(' - Index Upload failed');
    console.error(e);
  }

  console.log('Job finished');
};

job()
  .catch(reason => {
    console.error('process failed');
    console.error(reason);
    process.exit(1);
  })
  .then(() => {
    process.exit(0);
    console.log('Job quit');
  });
