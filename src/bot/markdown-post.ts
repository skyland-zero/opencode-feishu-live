/**
 * Markdown → Feishu "post" payload helpers.
 *
 * Feishu text messages do NOT render markdown; a post message whose content rows
 * carry ``{"tag": "md", "text": ...}`` elements DOES (bold, headings, tables,
 * code blocks …). These helpers mirror Hermes's own Feishu adapter behavior
 * (plugins/platforms/feishu/adapter.py): markdown-looking content is sent as a
 * post, with each fenced code block in its own row (Feishu's md renderer can
 * swallow trailing content when a fence sits inside one large element).
 */

/** Matches content worth sending as a markdown post (port of Hermes _MARKDOWN_HINT_RE). */
export const MARKDOWN_HINT_RE = new RegExp(
  [
    // Pipe table: header line + separator line both starting with '|'.
    '(^\\|.*\\|\\s*\\n\\|[-:|\\s]+\\|)',
    // Headings, lists, code, bold/italic/strike/underline, links, blockquotes.
    '(^#{1,6}\\s)',
    '(^\\s*[-*]\\s)',
    '(^\\s*\\d+\\.\\s)',
    '(^\\s*-{3,}\\s*$)',
    '(```)',
    '(`[^`\\n]+`)',
    '(\\*\\*[^*\\n].+?\\*\\*)',
    '(~~[^~\\n].+?~~)',
    '(<u>.+?</u>)',
    '(\\*[^*\\n]+\\*)',
    '(\\[[^\\]]+\\]\\([^)]+\\))',
    '(^>\\s)',
  ].join('|'),
  'm',
);

const FENCE_OPEN_RE = /^```([^\n`]*)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const POST_CONTENT_INVALID_RE = /content format of the post type is incorrect/i;
const POST_CONTENT_INVALID_CN_RE = /内容格式不正确/;

export interface PostElement {
  tag: string;
  text: string;
}

export function hasMarkdownHints(text: string): boolean {
  return MARKDOWN_HINT_RE.test(text);
}

/** Mirrors Hermes _build_markdown_post_payload: {"zh_cn": {"content": [[{tag:"md", text}], …]}} */
export function buildMarkdownPostPayload(content: string): string {
  const rows = buildMarkdownPostRows(content);
  return JSON.stringify({ zh_cn: { content: rows } }, null, 0);
}

export function buildMarkdownPostRows(content: string): PostElement[][] {
  if (!content) {
    return [[{ tag: 'md', text: '' }]];
  }
  if (!content.includes('```')) {
    return [[{ tag: 'md', text: content }]];
  }

  const rows: PostElement[][] = [];
  let current: string[] = [];
  let inCodeBlock = false;

  const flush = (): void => {
    const segment = current.join('\n');
    if (segment.trim()) {
      rows.push([{ tag: 'md', text: segment }]);
    }
    current = [];
  };

  for (const rawLine of content.split('\n')) {
    const fenceRe = inCodeBlock ? FENCE_CLOSE_RE : FENCE_OPEN_RE;
    const isFence = fenceRe.test(rawLine.trim());
    if (isFence && !inCodeBlock) {
      // Opening fence: prose before it becomes its own row.
      flush();
    }
    current.push(rawLine);
    if (isFence) {
      inCodeBlock = !inCodeBlock;
      if (!inCodeBlock) {
        // Closing fence: the code block becomes its own row.
        flush();
      }
    }
  }
  flush();
  return rows.length > 0 ? rows : [[{ tag: 'md', text: content }]];
}

/** Plain-text fallback when the API rejects a post payload (Hermes-style strip). */
export function stripMarkdownToPlainText(text: string): string {
  let out = text;
  // Fenced code blocks: keep the inner lines, drop the fence lines.
  out = out.replace(/```[^\n]*\n([\s\S]*?)```/g, '$1');
  out = out.replace(/```/g, '');
  // Inline code.
  out = out.replace(/`([^`\n]+)`/g, '$1');
  // Images ![alt](url) and links [label](url) → label / alt.
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Bold / italic / strike / underline.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  out = out.replace(/__([^_\n]+)__/g, '$1');
  out = out.replace(/\*([^*\n]+)\*/g, '$1');
  out = out.replace(/~~([^~\n]+)~~/g, '$1');
  out = out.replace(/<u>(.+?)<\/u>/g, '$1');
  // Headings and blockquote markers.
  out = out.replace(/^#{1,6}\s+/gm, '');
  out = out.replace(/^>\s?/gm, '');
  // Horizontal rules.
  out = out.replace(/^\s*-{3,}\s*$/gm, '');
  // Squeeze excess blank lines.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/** True when an API error means the post payload was rejected by content format. */
export function isPostContentInvalidError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return POST_CONTENT_INVALID_RE.test(message) || POST_CONTENT_INVALID_CN_RE.test(message);
}
