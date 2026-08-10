const TOKEN_KEY = 'teamhub_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export async function uploadFiles(files) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data.attachments;
}

// Platform admin: publish the latest Android APK for the portal's download button.
export async function uploadAndroidApk(file) {
  const fd = new FormData();
  fd.append('apk', file);
  const res = await fetch('/api/platform/android-apk', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

// Upload files straight into the shared team Drive (optionally into a folder,
// optionally tagged / shared with a set of teammates).
export async function uploadToDrive(files, folderId = null, sharedWith = []) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  if (folderId != null) fd.append('folder_id', String(folderId));
  if (sharedWith && sharedWith.length) fd.append('shared_with', JSON.stringify(sharedWith));
  const res = await fetch('/api/drive', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data.files;
}

// Download the bulk task-import spreadsheet template (.xlsx) and save it.
export async function downloadTaskTemplate() {
  const res = await fetch('/api/tasks/import/template', { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error('Could not download the template');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'task-import-template.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Upload a filled template to bulk-create tasks. Returns { created, errors:[{row,message}] }.
export async function importTasks(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/tasks/import', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Import failed');
  return data;
}

// Download an Analytics report as an .xlsx. `params` is an object of query
// values (e.g. { period: 'month', user_id: 3 }).
export async function downloadReport(type, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  const res = await fetch(`/api/analytics/reports/${type}/export?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error('Could not export the report');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${type}-report.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Upload a profile photo; returns the updated public user.
export async function uploadAvatar(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/uploads/avatar', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data.user;
}

// Authenticated file URL usable directly in <img src> / <a href> (inline).
export function fileUrl(id) {
  return `/api/uploads/${id}?token=${encodeURIComponent(getToken())}`;
}

// Same file, but forced as an attachment so it downloads (needed for the native
// Android WebView, which hands Content-Disposition: attachment to DownloadManager).
export function downloadUrl(id) {
  return `${fileUrl(id)}&download=1`;
}

// A single zip of many Drive files and/or whole folders (browsers cap parallel
// downloads, so bundling avoids losing files; folders download with structure).
export function zipUrl(fileIds = [], folderIds = []) {
  const qs = new URLSearchParams();
  if (fileIds.length) qs.set('files', fileIds.join(','));
  if (folderIds.length) qs.set('folders', folderIds.join(','));
  qs.set('token', getToken());
  return `/api/uploads/zip?${qs.toString()}`;
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, code: data.code, data });
  return data;
}
