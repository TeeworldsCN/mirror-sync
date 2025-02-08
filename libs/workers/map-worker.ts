declare var self: Worker;

import { downloadDDNetMap } from '../ddnet';
import { upload } from '../storage';
import { validate } from '../validator';

self.onmessage = async (event: MessageEvent) => {
  const { map, id } = event.data;
  try {
    const data = await downloadDDNetMap(map);
    const { valid, reason } = validate(map, data);
    if (!valid) {
      self.postMessage({ map, success: false, reason });
      return;
    }
    await upload(map, data);
    self.postMessage({ id, map, success: true, size: data.length, date: new Date().getTime() });
  } catch (e) {
    self.postMessage({ id, map, success: false, reason: e.message });
  }
};
