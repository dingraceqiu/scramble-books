/**
 * EPUB 书籍解析器
 *
 * 职责：EPUB(zip) -> Canonical Source Map（Chapter -> SourceNode）
 * 流程：container.xml -> OPF(manifest/spine/metadata) -> 逐份 XHTML 提取段落
 * 章节标题优先取 EPUB3 nav / EPUB2 ncx 目录，其次取文内首个标题。
 */
import JSZip from 'jszip';
import type { Chapter, ParsedBook, SourceNode } from '../../types';
import { uid } from '../utils';

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,dt,dd';

function xmlText(el: Element | null | undefined, tag: string): string | undefined {
  if (!el) return undefined;
  const nodes = el.getElementsByTagName(tag);
  for (let i = 0; i < nodes.length; i++) {
    const t = nodes[i].textContent?.trim();
    if (t) return t;
  }
  return undefined;
}

function normalizePath(p: string): string {
  const decoded = decodeURIComponent(p.split('#')[0].split('?')[0]).replace(/\\/g, '/');
  const parts = decoded.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function joinPath(baseDir: string, href: string): string {
  const clean = href.split('#')[0].split('?')[0];
  const full = baseDir ? `${baseDir}/${clean}` : clean;
  return normalizePath(full);
}

function cleanText(text: string): string {
  return text.replace(/[ \t\r\n\f]+/g, ' ').replace(/\u00A0/g, ' ').trim();
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** 从 EPUB3 nav.xhtml 或 EPUB2 ncx 中提取 路径 -> 章节名 映射 */
async function extractTocLabels(
  zip: JSZip,
  opfDir: string,
  manifest: Map<string, ManifestItem>,
  opfDoc: Document,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();

  const navItem = [...manifest.values()].find(
    (it) => it.properties.split(/\s+/).includes('nav') || it.mediaType === 'application/xhtml+xml' && it.href.endsWith('nav.xhtml'),
  );
  const spineEl = xmlChild(opfDoc, 'spine');
  const ncxItem =
    [...manifest.values()].find((it) => it.mediaType === 'application/x-dtbncx+xml') ||
    (() => {
      const tocId = spineEl?.getAttribute('toc');
      return tocId ? manifest.get(tocId) : undefined;
    })();

  if (navItem) {
    const file = zip.file(joinPath(opfDir, navItem.href));
    if (file) {
      const html = await file.async('string');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const anchors = doc.getElementsByTagName('a');
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        const href = a.getAttribute('href');
        const label = cleanText(a.textContent || '');
        if (href && label) labels.set(joinPath(opfDir, href), label);
      }
    }
  }

  if (labels.size === 0 && ncxItem) {
    const file = zip.file(joinPath(opfDir, ncxItem.href));
    if (file) {
      const xml = await file.async('string');
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const points = doc.getElementsByTagName('navPoint');
      for (let i = 0; i < points.length; i++) {
        const label = cleanText(xmlText(points[i], 'text') || '');
        const content = points[i].getElementsByTagName('content')[0];
        const src = content?.getAttribute('src');
        if (label && src) labels.set(joinPath(opfDir, src), label);
      }
    }
  }

  return labels;
}

function xmlChild(doc: Document, tag: string): Element | null {
  const list = doc.getElementsByTagName(tag);
  return list.length > 0 ? list[0] : null;
}

export async function parseEpubBuffer(buf: ArrayBuffer): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(buf);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('EPUB 结构异常：缺少 META-INF/container.xml');
  const containerDoc = new DOMParser().parseFromString(
    await containerFile.async('string'),
    'application/xml',
  );
  const rootfile = containerDoc.getElementsByTagName('rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB 结构异常：找不到 OPF 文件');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const opfDoc = new DOMParser().parseFromString(
    await zip.file(normalizePath(opfPath))!.async('string'),
    'application/xml',
  );

  const metadata = xmlChild(opfDoc, 'metadata');
  const title = xmlText(metadata, 'dc:title') || '未命名书籍';
  const author = xmlText(metadata, 'dc:creator') || '未知作者';

  // manifest
  const manifest = new Map<string, ManifestItem>();
  const manifestEl = xmlChild(opfDoc, 'manifest');
  if (manifestEl) {
    const items = manifestEl.getElementsByTagName('item');
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      const id = el.getAttribute('id');
      const href = el.getAttribute('href');
      if (!id || !href) continue;
      manifest.set(id, {
        id,
        href,
        mediaType: el.getAttribute('media-type') || '',
        properties: el.getAttribute('properties') || '',
      });
    }
  }

  // 封面
  let coverDataUrl: string | undefined;
  const coverMetaId = metadata?.getElementsByTagName('meta').length
    ? (() => {
        const metas = metadata!.getElementsByTagName('meta');
        for (let i = 0; i < metas.length; i++) {
          if (metas[i].getAttribute('name') === 'cover') return metas[i].getAttribute('content');
        }
        return undefined;
      })()
    : undefined;
  const coverItem =
    [...manifest.values()].find((it) => it.properties.split(/\s+/).includes('cover-image')) ||
    (coverMetaId ? manifest.get(coverMetaId) : undefined) ||
    [...manifest.values()].find(
      (it) => it.mediaType.startsWith('image/') && /cover|封面/i.test(it.href),
    );
  if (coverItem) {
    const coverFile = zip.file(joinPath(opfDir, coverItem.href));
    if (coverFile) {
      const blob = await coverFile.async('blob');
      coverDataUrl = await blobToDataUrl(
        new Blob([blob], { type: coverItem.mediaType || 'image/jpeg' }),
      );
    }
  }

  const tocLabels = await extractTocLabels(zip, opfDir, manifest, opfDoc);

  // spine -> chapters
  const chapters: Chapter[] = [];
  const spineEl = xmlChild(opfDoc, 'spine');
  if (!spineEl) throw new Error('EPUB 结构异常：缺少 spine');
  const itemrefs = spineEl.getElementsByTagName('itemref');

  for (let i = 0; i < itemrefs.length; i++) {
    const idref = itemrefs[i].getAttribute('idref');
    if (!idref) continue;
    const item = manifest.get(idref);
    if (!item) continue;
    if (item.mediaType && !item.mediaType.includes('xml') && !item.mediaType.includes('html')) continue;

    const fullPath = joinPath(opfDir, item.href);
    const file = zip.file(fullPath);
    if (!file) continue;

    const doc = new DOMParser().parseFromString(await file.async('string'), 'text/html');
    const body = doc.body;
    if (!body) continue;

    const nodes: SourceNode[] = [];
    const blocks = body.querySelectorAll(BLOCK_SELECTOR);
    for (let j = 0; j < blocks.length; j++) {
      const el = blocks[j];
      // 跳过被同类块级元素嵌套的节点（避免 blockquote>p 重复提取）
      if (el.parentElement?.closest(BLOCK_SELECTOR)) continue;
      // 跳过目录页残留（nav 内链接列表）
      if (el.closest('nav')) continue;
      const text = cleanText(el.textContent || '');
      if (!text) continue;
      const tag = el.tagName.toLowerCase();
      const type: SourceNode['type'] = /^h[1-6]$/.test(tag)
        ? 'heading'
        : tag === 'li' || tag === 'dt'
          ? 'list'
          : 'para';
      nodes.push({ id: '', index: nodes.length, type, text });
    }
    if (nodes.length === 0) continue;

    const chapterId = uid('ch');
    nodes.forEach((n, idx) => {
      n.id = `${chapterId}__n${idx}`;
    });

    const firstHeading = nodes.find((n) => n.type === 'heading');
    const fileName = item.href.split('/').pop()?.replace(/\.[^.]+$/, '') || `章节 ${i + 1}`;
    const label =
      tocLabels.get(fullPath) ||
      tocLabels.get(normalizePath(item.href)) ||
      firstHeading?.text ||
      fileName;

    chapters.push({ id: chapterId, index: chapters.length, title: cleanText(label), nodes });
  }

  if (chapters.length === 0) throw new Error('未能从 EPUB 中提取到任何正文内容');

  // 主题词（dc:subject），用于书籍类型推测
  const subjects = metadata
    ? Array.from(metadata.getElementsByTagName('dc:subject'))
        .map((el) => (el.textContent ?? '').trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];

  return { title, author, format: 'epub', coverDataUrl, subjects, chapters };
}
