// Template storage. Two interchangeable stores with the same methods:
//   list() → [{ id, name, width, height, thumbnail, updatedAt }]
//   get(id) → { id, name, width, height, objects, thumbnail, background: Blob, original: Blob|null, updatedAt }
//   put(rec) — rec.background / rec.original may be null meaning "unchanged"
//   remove(id)
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_BUCKET } from './config.js';
import { blobToDataURL } from './imaging.js';
import { t } from './i18n.js';

const DB_NAME = 'template-maker';
const STORE = 'templates';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export class LocalStore {
  labelKey = 'storeLocal';
  whereKey = 'storeLocalIn';
  isCloud = false;

  async list() {
    const db = await openDb();
    const all = await tx(db, 'readonly', (s) => s.getAll());
    return all
      .map(({ id, name, width, height, thumbnail, updatedAt }) => ({ id, name, width, height, thumbnail, updatedAt }))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  async get(id) {
    const db = await openDb();
    const rec = await tx(db, 'readonly', (s) => s.get(id));
    if (!rec) throw new Error(t('errNotFound'));
    return rec;
  }

  async put(rec) {
    const db = await openDb();
    const prev = await tx(db, 'readonly', (s) => s.get(rec.id));
    const merged = {
      ...prev,
      ...rec,
      background: rec.background || prev?.background || null,
      original: rec.original || prev?.original || null,
    };
    await tx(db, 'readwrite', (s) => s.put(merged));
  }

  async remove(id) {
    const db = await openDb();
    await tx(db, 'readwrite', (s) => s.delete(id));
  }
}

export const cloudConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let clientPromise;
export function getSupabase() {
  clientPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js';
    s.onload = () => resolve(window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
    s.onerror = () => { clientPromise = null; reject(new Error(t('errSupabase'))); };
    document.head.appendChild(s);
  });
  return clientPromise;
}

const unwrap = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

export class CloudStore {
  labelKey = 'storeCloud';
  whereKey = 'storeCloudIn';
  isCloud = true;

  constructor(client, user) {
    this.db = client;
    this.user = user;
    this.bucket = client.storage.from(SUPABASE_BUCKET);
  }

  async list() {
    const rows = unwrap(await this.db.from('templates')
      .select('id,name,width,height,thumbnail,updated_at')
      .order('updated_at', { ascending: false }));
    return rows.map((r) => ({ ...r, updatedAt: r.updated_at }));
  }

  async get(id) {
    const row = unwrap(await this.db.from('templates').select('*').eq('id', id).single());
    const [background, original] = await Promise.all([
      row.background_path ? this.bucket.download(row.background_path).then(unwrap) : null,
      row.original_path ? this.bucket.download(row.original_path).then(unwrap) : null,
    ]);
    return {
      id: row.id, name: row.name, width: row.width, height: row.height,
      objects: row.objects, thumbnail: row.thumbnail, updatedAt: row.updated_at,
      background, original,
    };
  }

  async put(rec) {
    const dir = `${this.user.id}/${rec.id}`;
    const row = {
      id: rec.id, name: rec.name, width: rec.width, height: rec.height,
      objects: rec.objects, thumbnail: rec.thumbnail, updated_at: rec.updatedAt,
    };
    if (rec.background) {
      row.background_path = `${dir}/background.jpg`;
      unwrap(await this.bucket.upload(row.background_path, rec.background, { upsert: true, contentType: rec.background.type }));
    }
    if (rec.original) {
      row.original_path = `${dir}/original.jpg`;
      unwrap(await this.bucket.upload(row.original_path, rec.original, { upsert: true, contentType: rec.original.type }));
    }
    unwrap(await this.db.from('templates').upsert(row));
  }

  async remove(id) {
    const dir = `${this.user.id}/${id}`;
    await this.bucket.remove([`${dir}/background.jpg`, `${dir}/original.jpg`]);
    unwrap(await this.db.from('templates').delete().eq('id', id));
  }
}

/** Portable single-file template (.json) with images inlined. */
export async function recordToFile(rec) {
  return new Blob([JSON.stringify({
    format: 'template-maker',
    version: 1,
    ...rec,
    background: rec.background ? await blobToDataURL(rec.background) : null,
    original: rec.original ? await blobToDataURL(rec.original) : null,
  })], { type: 'application/json' });
}

export async function fileToRecord(file) {
  const data = JSON.parse(await file.text());
  if (data.format !== 'template-maker') throw new Error(t('errNotTemplate'));
  const toBlob = async (url) => (url ? (await fetch(url)).blob() : null);
  return { ...data, background: await toBlob(data.background), original: await toBlob(data.original) };
}
