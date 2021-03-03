import axios from 'axios';
import cheerio from 'cheerio';
import COS from 'cos-nodejs-sdk-v5';
import fs from 'fs';

require('dotenv').config();

let cos = new COS({
  SecretId: process.env.COS_SECRET,
  SecretKey: process.env.COS_SECRET_KEY,
});

const download = async (map: any) => {
  const response = await axios.get(`https://maps.ddnet.tw/${map.link}`, {
    responseType: 'stream',
  });

  response.data.pipe(fs.createWriteStream(`tmp/${map.filename}`));

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

  const bucketMaps: { [key: string]: string } = {};
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
      bucketMaps[item.Key] = item.LastModified;
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
        download(map);
        console.log(' - Downloaded');
      } catch {
        console.log(' - Download failed');
        continue;
      }

      try {
        await cos.sliceUploadFile({
          Bucket: process.env.COS_MAP_BUCKET,
          Region: process.env.COS_REGION,
          Key: map.filename,
          FilePath: `./tmp/${map.filename}`,
        });
        console.log(' - Uploaded');
        bucketMaps[map.filename] = new Date().toISOString();
      } catch (e) {
        console.log(' - Upload failed');
        console.log(e);
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
      fs.unlinkSync(`./tmp/${map.filename}`);
    } catch {
      console.log(` - Failed to remove file ${map.filename}`);
    }
  }

  console.log('Job finished');
};

job().catch(reason => {
  console.error('process failed');
  console.error(reason);
  process.exit(1);
});
