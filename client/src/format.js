import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true, gfm: true });

// Make links open safely in a new tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Render message text as sanitized HTML: markdown for formatting, then
 * highlight @mentions. The mention names come from our own DB and are
 * HTML-escaped, so the post-sanitize injection is fully controlled.
 */
export function renderMarkdown(content, mentions = []) {
  const html = marked.parse(content || '');
  let clean = DOMPurify.sanitize(html);
  for (const mn of mentions) {
    const token = escapeHtml('@' + mn.name);
    clean = clean.split(token).join(`<span class="mention">${token}</span>`);
  }
  return clean;
}

// Render a reminder timestamp for display. The server stores reminders as
// UTC "YYYY-MM-DD HH:MM:SS"; ISO strings are handled too.
export function formatDateTime(value) {
  if (!value) return '';
  const d = new Date(/[TZ]/.test(value) ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
