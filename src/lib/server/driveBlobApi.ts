import crypto from "crypto";
import { BlobStoreError, type DriveBlobApi } from "@/lib/server/driveBlobStore";
import { fetchWithRetry, throwForStatus, type RetryOptions } from "@/lib/server/driveBlobHttp";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

function assertId(id: unknown): string {
  if (typeof id !== "string" || !DRIVE_ID.test(id)) throw new BlobStoreError("upstream");
  return id;
}

/** Drive v3 implementation of DriveBlobApi using plain fetch and the caller's access token (drive.file scope). */
export function createDriveBlobApi(accessToken: string, fetchFn: typeof fetch = fetch, retry: RetryOptions = {}): DriveBlobApi {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const call = (url: string, init: RequestInit = {}) => fetchWithRetry(fetchFn, url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }, retry);

  return {
    async getFolder(folderId) {
      if (!DRIVE_ID.test(folderId)) return null;
      const res = await call(`${DRIVE_API}/files/${folderId}?fields=id,trashed,mimeType`);
      if (res.status === 404) return null;
      if (!res.ok) return throwForStatus(res);
      const data = (await res.json()) as { id?: string; trashed?: boolean; mimeType?: string };
      return data.mimeType === FOLDER_MIME && data.id ? { id: data.id, trashed: Boolean(data.trashed) } : null;
    },
    async findFolder(name) {
      const q = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`);
      const res = await call(`${DRIVE_API}/files?q=${q}&fields=files(id)&pageSize=1&spaces=drive`);
      if (!res.ok) return throwForStatus(res);
      const data = (await res.json()) as { files?: Array<{ id?: string }> };
      return data.files?.[0]?.id ? assertId(data.files[0].id) : null;
    },
    async createFolder(name) {
      const res = await call(`${DRIVE_API}/files?fields=id`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
      });
      if (!res.ok) return throwForStatus(res);
      return assertId(((await res.json()) as { id?: string }).id);
    },
    async createFile({ name, parentId, json }) {
      const boundary = `slblob${crypto.randomBytes(8).toString("hex")}`;
      const metadata = JSON.stringify({ name, parents: [parentId], mimeType: "application/json" });
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
      const res = await call(`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,version`, {
        method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
      });
      if (!res.ok) return throwForStatus(res);
      const data = (await res.json()) as { id?: string; version?: string };
      return { id: assertId(data.id), version: data.version ?? null };
    },
    async updateFile(fileId, json) {
      if (!DRIVE_ID.test(fileId)) return null;
      const res = await call(`${DRIVE_UPLOAD_API}/${fileId}?uploadType=media&fields=id,version,trashed`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: json,
      });
      if (res.status === 404) return null;
      if (!res.ok) return throwForStatus(res);
      const data = (await res.json()) as { id?: string; version?: string; trashed?: boolean };
      return { id: assertId(data.id), version: data.version ?? null, trashed: Boolean(data.trashed) };
    },
    async getFileMeta(fileId) {
      if (!DRIVE_ID.test(fileId)) return null;
      const res = await call(`${DRIVE_API}/files/${fileId}?fields=trashed,version`);
      if (res.status === 404) return null;
      if (!res.ok) return throwForStatus(res);
      const data = (await res.json()) as { trashed?: boolean; version?: string };
      return { trashed: Boolean(data.trashed), version: data.version ?? null };
    },
    async getFileContent(fileId) {
      if (!DRIVE_ID.test(fileId)) return null;
      const res = await call(`${DRIVE_API}/files/${fileId}?alt=media`);
      if (res.status === 404) return null;
      if (!res.ok) return throwForStatus(res);
      return res.text();
    },
    async trashFile(fileId) {
      if (!DRIVE_ID.test(fileId)) return;
      const res = await call(`${DRIVE_API}/files/${fileId}?fields=id`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }),
      });
      if (res.status === 404) return;
      if (!res.ok) await throwForStatus(res);
    },
  };
}
