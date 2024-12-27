import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import fs from 'fs/promises';
import { resolve } from 'path';
import mime from 'mime-types';

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.COS_SECRET,
    secretAccessKey: process.env.COS_SECRET_KEY,
  },
  region: process.env.COS_REGION,
  endpoint: `https://cos.${process.env.COS_REGION}.myqcloud.com`,
});

export const getBucketMapFromBucket = async () => {
  // download straight from cos
  const command = new GetObjectCommand({
    Bucket: process.env.COS_MAP_BUCKET,
    Key: 'maps.json',
  });
  const data = await s3.send(command);
  const result = JSON.parse(await data.Body.transformToString());
  return result;
};

export const getBucketMap = async () => {
  const bucketMaps: { [key: string]: { date: number; size: number } } = {};

  let contiuationToken: string | undefined = undefined;
  let total = 0;

  while (true) {
    const command = new ListObjectsV2Command({
      Bucket: process.env.COS_MAP_BUCKET,
      ContinuationToken: contiuationToken,
    });
    const data = await s3.send(command);
    for (let item of data.Contents) {
      if (!item.Key.endsWith('.map')) continue;
      bucketMaps[item.Key] = {
        date: item.LastModified.getTime(),
        size: item.Size,
      };
    }
    total += data.Contents.length;
    console.log(` - Bucket contains ${total} items`);
    if (!data.IsTruncated) break;
    contiuationToken = data.NextContinuationToken;
  }
  return bucketMaps;
};

export const upload = async (key: string, data: Buffer | string) => {
  const type = (!key.endsWith('.map') && mime.lookup(key)) || 'application/octet-stream';
  if (process.env.UPLOAD) {
    // only upload for real if UPLOAD is set
    return await s3.send(
      new PutObjectCommand({
        Bucket: process.env.COS_MAP_BUCKET,
        Key: key,
        Body: data,
        ContentType: type,
      })
    );
  } else {
    if (typeof data === 'string') {
      return await fs.writeFile(resolve(process.env.TMP_PATH, key), data);
    } else {
      return await fs.writeFile(resolve(process.env.TMP_PATH, key), new DataView(data.buffer));
    }
  }
};

export const deleteFile = async (key: string) => {
  const command = new DeleteObjectCommand({
    Bucket: process.env.COS_MAP_BUCKET,
    Key: key,
  });
  return await s3.send(command);
};
