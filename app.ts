// github-core-clone-01 forge: one-process, Node stdlib only, no git binary, no network.
// Surfaces: git smart HTTP (v2 upload-pack, v0 upload/receive-pack), REST v3 /api/v3,
// GraphQL v4 /api/graphql, MCP /mcp, GET /healthz, GET /api/v3/ root.
// Store is in-memory and deterministic: commit timestamps derive from a per-repo
// sequence counter, never from the wall clock; iteration order is insertion order.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ZERO_OID = '0000000000000000000000000000000000000000';
const BASE_TS = 1700000000; // deterministic commit timestamps: BASE_TS + seq
let reqSeq = 0;
let globalSeq = 0;

// ---------------------------------------------------------------- utilities
function sha1(buf: Buffer): string { return createHash('sha1').update(buf).digest('hex'); }
function isSha(s: unknown): s is string { return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s); }
function b64(buf: Buffer): string { return buf.toString('base64'); }
function unb64(s: string): Buffer { return Buffer.from(s, 'base64'); }
function reqId(): string { reqSeq += 1; return `req-${reqSeq.toString(36)}`; }
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, buf: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length, ...headers });
  res.end(buf);
}
function pathOf(req: IncomingMessage): string {
  try { return decodeURIComponent(new URL(req.url ?? '/', 'http://entry').pathname); } catch { return '/'; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function authOk(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice(7);
  if (TOKEN === '') return tok.length > 0;
  if (tok.length !== TOKEN.length) return false;
  try { return timingSafeEqual(Buffer.from(tok), Buffer.from(TOKEN)); } catch { return false; }
}

// ---------------------------------------------------------------- git objects
type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer; }
function objId(type: ObjType, data: Buffer): string {
  const hdr = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([hdr, data]));
}
function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const out: Array<{ mode: string; name: string; oid: string }> = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0, sp);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}
function buildTree(entries: Array<{ mode: string; name: string; oid: string }>): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitInfo { tree: string; parents: string[]; message: string; }
function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = ''; const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message, author: '' };
}
function makeCommit(tree: string, parents: string[], message: string, ts: number): { oid: string; data: Buffer } {
  const who = `Forge <forge@example.invalid> ${ts} +0000`;
  let body = `tree ${tree}\n`;
  for (const p of parents) body += `parent ${p}\n`;
  body += `author ${who}\ncommitter ${who}\n\n${message}\n`;
  const data = Buffer.from(body, 'utf8');
  return { oid: objId('commit', data), data };
}
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, p, out);
    else out.set(p, { oid: e.oid, mode: e.mode });
  }
}
function treeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const build = (prefix: string): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [path, f] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: f.mode, name: rest, oid: f.oid });
      else {
        const dir = rest.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, new Map());
        dirs.get(dir)!.set(path, f);
      }
    }
    for (const [dir] of [...dirs.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
      const subPrefix = prefix ? `${prefix}/${dir}` : dir;
      entries.push({ mode: '40000', name: dir, oid: build(subPrefix) });
    }
    const data = buildTree(entries);
    const oid = objId('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build('');
}
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}
function reachableObjects(repo: Repo, tips: string[], haves: Set<string>): Map<string, GitObj> {
  const want = new Map<string, GitObj>();
  const seen = new Set<string>();
  const stack = [...tips];
  const collect = (oid: string, into: Set<string> | Map<string, GitObj>): void => {
    if (into instanceof Set) into.add(oid);
  };
  void collect;
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    want.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (m) stack.push(m[1]);
    }
  }
  if (haves.size) {
    const haveSeen = new Set<string>();
    const hstack = [...haves];
    while (hstack.length) {
      const oid = hstack.pop()!;
      if (haveSeen.has(oid)) continue;
      haveSeen.add(oid);
      want.delete(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit') { const c = parseCommit(obj.data); hstack.push(c.tree); for (const p of c.parents) hstack.push(p); }
      else if (obj.type === 'tree') { for (const e of parseTree(obj.data)) hstack.push(e.oid); }
    }
  }
  return want;
}

// ---------------------------------------------------------------- packfiles
function packEntryHeader(typeNum: number, size: number): Buffer {
  const out: number[] = [];
  let b = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  out.push(b);
  while (size > 0) { out.push(size & 0x7f); size >>= 7; }
  for (let i = 0; i < out.length - 1; i++) out[i] |= 0x80;
  return Buffer.from(out);
}
function buildPack(objects: Map<string, GitObj>): Buffer {
  const typeRank: Record<string, number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  const list = [...objects.entries()].sort((a, b) => (typeRank[a[1].type] - typeRank[b[1].type]) || (a[0] < b[0] ? -1 : 1));
  const parts: Buffer[] = [];
  const hdr = Buffer.alloc(12);
  hdr.write('PACK', 0); hdr.writeUInt32BE(2, 4); hdr.writeUInt32BE(list.length, 8);
  parts.push(hdr);
  for (const [, obj] of list) {
    const typeNum = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    parts.push(packEntryHeader(typeNum, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const trailer = createHash('sha1').update(Buffer.concat(parts)).digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let v = 0; let shift = 0;
    while (pos < delta.length) { const b = delta[pos++]; v |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
    return v;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  while (pos < delta.length) {
    const cmd = delta[pos++];
    if (cmd & 0x80) {
      let off = 0; let size = 0;
      for (let i = 0; i < 4; i++) if (cmd & (1 << i)) off |= delta[pos++] << (8 * i);
      for (let i = 0; i < 3; i++) if (cmd & (0x10 << i)) size |= delta[pos++] << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
    } else if (cmd > 0) {
      out.push(delta.subarray(pos, pos + cmd)); pos += cmd;
    } else throw new Error('delta opcode 0');
  }
  const res = Buffer.concat(out);
  if (res.length !== dstSize) throw new Error('delta result size mismatch');
  return res;
}
// Find the end of the zlib stream starting at `pos`: inflateSync throws on a
// truncated stream, so exponential + binary search for the first end that works.
function inflateAt(buf: Buffer, pos: number): { data: Buffer; next: number } {
  let step = 256;
  let hi = -1;
  let end = Math.min(buf.length, pos + step);
  while (end <= buf.length) {
    try { inflateSync(buf.subarray(pos, end)); hi = end; break; } catch { /* truncated */ }
    if (end === buf.length) break;
    step *= 2;
    end = Math.min(buf.length, pos + step);
  }
  if (hi < 0) throw new Error('zlib stream not found in pack');
  let lo = pos + 1;
  // binary search smallest end in (pos, hi] that inflates
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try { inflateSync(buf.subarray(pos, mid)); hi = mid; } catch { lo = mid + 1; }
  }
  return { data: inflateSync(buf.subarray(pos, lo)), next: lo };
}
function parsePack(buf: Buffer): Map<string, GitObj> {
  if (buf.length < 12 || buf.subarray(0, 4).toString() !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  let pos = 12;
  const byOffset = new Map<number, GitObj>();
  const out = new Map<string, GitObj>();
  interface Pend { offset: number; baseOff?: number; baseOid?: string; delta: Buffer; }
  const pending: Pend[] = [];
  const store = (offset: number, type: ObjType, data: Buffer): void => {
    const oid = objId(type, data);
    byOffset.set(offset, { type, data });
    out.set(oid, { type, data });
  };
  for (let n = 0; n < count; n++) {
    const start = pos;
    let b = buf[pos++];
    const typeNum = (b >> 4) & 7;
    let size = b & 0x0f; let shift = 4;
    while (b & 0x80) { b = buf[pos++]; size |= (b & 0x7f) << shift; shift += 7; }
    let baseOff = -1; let baseOid = '';
    if (typeNum === 6) {
      let offByte = buf[pos++]; let off = offByte & 0x7f;
      while (offByte & 0x80) { offByte = buf[pos++]; off = ((off + 1) << 7) | (offByte & 0x7f); }
      baseOff = start - off;
    } else if (typeNum === 7) { baseOid = buf.subarray(pos, pos + 20).toString('hex'); pos += 20; }
    const { data, next } = inflateAt(buf, pos);
    pos = next;
    void size;
    if (typeNum === 1) store(start, 'commit', data);
    else if (typeNum === 2) store(start, 'tree', data);
    else if (typeNum === 3) store(start, 'blob', data);
    else if (typeNum === 4) store(start, 'tag', data);
    else if (typeNum === 6) pending.push({ offset: start, baseOff, delta: data });
    else if (typeNum === 7) pending.push({ offset: start, baseOid, delta: data });
    else throw new Error(`unknown pack type ${typeNum}`);
  }
  // Resolve deltas (may chain; iterate until stable).
  for (let round = 0; round < 20 && pending.length; round++) {
    const rest: Pend[] = [];
    for (const p of pending) {
      let base: GitObj | undefined;
      if (p.baseOff !== undefined) base = byOffset.get(p.baseOff);
      else if (p.baseOid) base = out.get(p.baseOid);
      if (!base) { rest.push(p); continue; }
      const data = applyDelta(base.data, p.delta);
      store(p.offset, base.type, data);
    }
    pending.length = 0;
    pending.push(...rest);
    if (rest.length === 0) break;
  }
  if (pending.length) throw new Error('unresolved pack delta');
  return out;
}

// ---------------------------------------------------------------- store
interface Issue { number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; seq: number; id: number; comments: Array<{ id: number; body: string }>; }
interface Pull { number: number; title: string; body: string; state: 'open' | 'closed'; head: string; base: string; headSha: string; baseSha: string; merged: boolean; mergedAt: string; mergeSha: string; seq: number; id: number; files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>; }
interface Repo {
  name: string; owner: string | null; priv: boolean; description: string; defaultBranch: string;
  id: number; seq: number;
  objects: Map<string, GitObj>;
  refs: Map<string, string>; // full ref -> oid
  issues: Issue[]; pulls: Pull[]; labels: Map<string, { name: string; color: string }>;
  nextIssue: number; nextPull: number; nextComment: number; commitSeq: number;
}
let viewerLogin: string | null = null; // learned from the first owner seen in a path
let repoCounter = 0;
const repos = new Map<string, Repo>(); // by name
function getRepoByName(name: string): Repo | undefined { return repos.get(name); }
// Bind/lookup a repo for an owner path segment. First owner seen becomes the viewer;
// a repo created owner-less is bound to the first owner that reads it.
function lookupRepo(owner: string, name: string): Repo | null {
  if (!viewerLogin) viewerLogin = owner;
  const r = repos.get(name);
  if (!r) return null;
  if (r.owner === null) r.owner = owner;
  if (r.owner !== owner) return null;
  return r;
}
function learnOwner(owner: string): void { if (!viewerLogin) viewerLogin = owner; }
function createRepo(name: string, priv: boolean, description: string): Repo {
  repoCounter += 1;
  const r: Repo = {
    name, owner: null, priv, description, defaultBranch: 'main',
    id: 1000 + repoCounter, seq: globalSeq++,
    objects: new Map(), refs: new Map(), issues: [], pulls: [], labels: new Map(),
    nextIssue: 1, nextPull: 1, nextComment: 1, commitSeq: 0,
  };
  repos.set(name, r);
  return r;
}
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, name: r.name, full_name: r.owner ? `${r.owner}/${r.name}` : r.name,
    owner: { login: r.owner ?? viewerLogin ?? '', id: 1000, type: 'User' },
    private: r.priv, description: r.description, default_branch: r.defaultBranch,
    html_url: `https://example.invalid/${r.owner ?? ''}/${r.name}`,
    url: `/api/v3/repos/${r.owner ?? ''}/${r.name}`, clone_url: '',
    has_issues: true, has_projects: true, has_wiki: true,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', pushed_at: '2026-01-01T00:00:00Z',
  };
}
function issueJson(r: Repo, iss: Issue): Record<string, unknown> {
  return {
    id: iss.id, number: iss.number, title: iss.title, body: iss.body, state: iss.state,
    labels: iss.labels.map((n) => ({ name: n, color: r.labels.get(n)?.color ?? 'ededed' })),
    user: { login: viewerLogin ?? '', id: 1000 }, assignee: null, assignees: [],
    comments: iss.comments.length, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    html_url: '', url: `/api/v3/repos/${r.owner}/${r.name}/issues/${iss.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
  };
}
function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id, number: p.number, title: p.title, body: p.body, state: p.state,
    head: { ref: p.head, sha: p.headSha, label: p.head, user: { login: viewerLogin ?? '' } },
    base: { ref: p.base, sha: p.baseSha, label: p.base, user: { login: viewerLogin ?? '' } },
    merged: p.merged, mergeable: !p.merged, merge_commit_sha: p.mergeSha || null,
    merged_at: p.merged ? p.mergedAt : null, merge_method: 'squash',
    user: { login: viewerLogin ?? '', id: 1000 }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    html_url: '', url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
  };
}
function gid(kind: string, r: Repo, n?: number): string {
  return Buffer.from(`${kind}:${r.id}:${n ?? ''}`, 'utf8').toString('base64').replace(/=+$/, '');
}
function branchTip(r: Repo, branch: string): string | undefined { return r.refs.get(`refs/heads/${branch}`); }
function filesAt(r: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = branchTip(r, branch);
  const out = new Map<string, { oid: string; mode: string }>();
  if (!tip) return out;
  const obj = r.objects.get(tip);
  if (!obj || obj.type !== 'commit') return out;
  flattenTree(r, parseCommit(obj.data).tree, '', out);
  return out;
}
function commitFiles(r: Repo, files: Map<string, { oid: string; mode: string }>, message: string, parents: string[]): { oid: string; tree: string } {
  const tree = treeFromFiles(r, files);
  r.commitSeq += 1;
  const ts = BASE_TS + r.commitSeq;
  const c = makeCommit(tree, parents, message, ts);
  r.objects.set(c.oid, { type: 'commit', data: c.data });
  return { oid: c.oid, tree };
}
function diffFiles(base: Map<string, { oid: string; mode: string }>, head: Map<string, { oid: string; mode: string }>): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const names = new Set([...base.keys(), ...head.keys()]);
  for (const name of [...names].sort()) {
    const b = base.get(name); const h = head.get(name);
    if (b && h && b.oid === h.oid) continue;
    if (!b && h) out.push({ filename: name, status: 'added', additions: 1, deletions: 0, changes: 1 });
    else if (b && !h) out.push({ filename: name, status: 'removed', additions: 0, deletions: 1, changes: 1 });
    else out.push({ filename: name, status: 'modified', additions: 1, deletions: 1, changes: 2 });
  }
  return out;
}
function paginate<T>(items: T[], q: URLSearchParams, baseUrl: string, path: string): { page: T[]; link: string } {
  const per = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(q.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * per;
  const page = items.slice(start, start + per);
  let link = '';
  if (start + per < items.length) {
    const next = new URLSearchParams(q);
    next.set('page', String(pageNum + 1)); next.set('per_page', String(per));
    link = `<${baseUrl}${path}?${next.toString()}>; rel="next"`;
  }
  return { page, link };
}
function jsonErr(res: ServerResponse, status: number, msg: string): void {
  sendJson(res, status, { message: msg }, { 'x-github-request-id': reqId() });
}

// ---------------------------------------------------------------- REST v3
function mergeBase(r: Repo, a: string, b: string): string | null {
  const ancA = new Map<string, number>();
  const stack: Array<[string, number]> = [[a, 0]];
  const seen = new Set<string>();
  while (stack.length) {
    const [oid, d] = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (!ancA.has(oid)) ancA.set(oid, d);
    const o = r.objects.get(oid);
    if (o && o.type === 'commit') for (const p of parseCommit(o.data).parents) stack.push([p, d + 1]);
  }
  // BFS from b, first ancestor in ancA with smallest depth from b is the merge base.
  const q: string[] = [b];
  const seenB = new Set<string>([b]);
  let best: string | null = null; let bestScore = Infinity;
  while (q.length) {
    const oid = q.shift()!;
    if (ancA.has(oid)) { const s = ancA.get(oid)!; if (s < bestScore) { bestScore = s; best = oid; } }
    const o = r.objects.get(oid);
    if (o && o.type === 'commit') for (const p of parseCommit(o.data).parents) if (!seenB.has(p)) { seenB.add(p); q.push(p); }
  }
  return best;
}
function commitsFrom(r: Repo, tip: string | undefined): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  if (!tip) return out;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const o = r.objects.get(oid);
    if (!o || o.type !== 'commit') continue;
    const c = parseCommit(o.data);
    out.push({ sha: oid, message: c.message.trimEnd() });
    for (const p of c.parents) stack.push(p);
  }
  return out;
}
async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams, bodyBuf: Buffer): Promise<boolean> {
  const method = req.method ?? 'GET';
  const rid = reqId();
  const headers: Record<string, string> = { 'x-github-request-id': rid };
  const ok = (status: number, body: unknown, extra: Record<string, string> = {}): void => sendJson(res, status, body, { ...headers, ...extra });
  const err = (status: number, msg: string): void => sendJson(res, status, { message: msg }, headers);
  // Root (starter behaviour, no auth).
  if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (!authOk(req)) { err(401, 'Requires authentication'); return true; }
  // Parse JSON body for mutating calls.
  let body: unknown = undefined;
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && bodyBuf.length > 0) {
    try { body = JSON.parse(bodyBuf.toString('utf8')); }
    catch { err(400, 'Problems parsing JSON'); return true; }
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
  const segs = path.split('/').filter((s) => s.length > 0); // ['api','v3',...]
  const rest = segs.slice(2);
  if (rest[0] === 'meta' && method === 'GET') { ok(200, { installed_version: '1.0.0' }); return true; }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = String(b.name ?? '');
      if (!name) { err(422, 'name is required'); return true; }
      const existing = repos.get(name);
      if (existing) { err(422, 'Repository already exists'); return true; }
      const r = createRepo(name, b.private === true, typeof b.description === 'string' ? b.description : '');
      ok(201, repoJson(r));
      return true;
    }
    if (method === 'GET') {
      const list = [...repos.values()].map(repoJson);
      const { page, link } = paginate(list, q, origin, path);
      ok(200, page, link ? { link } : {});
      return true;
    }
  }
  if (rest[0] === 'user' && method === 'GET' && rest.length === 1) {
    ok(200, { login: viewerLogin ?? '', id: 1000, type: 'User' });
    return true;
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1]; const name = rest[2];
    learnOwner(owner);
    const sub = rest.slice(3);
    const needRepo = sub[0] !== undefined || true;
    const r = lookupRepo(owner, name);
    if (!r && needRepo) { err(404, 'Not Found'); return true; }
    const repo = r!;
    if (sub.length === 0) {
      if (method === 'GET') { ok(200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        ok(200, repoJson(repo)); return true;
      }
      if (method === 'DELETE') { repos.delete(name); res.writeHead(204, headers); res.end(); return true; }
    }
    if (sub[0] === 'branches' && method === 'GET') {
      const out = [...repo.refs.entries()].filter(([k]) => k.startsWith('refs/heads/')).map(([k, sha]) => ({ name: k.slice('refs/heads/'.length), commit: { sha } }));
      ok(200, out); return true;
    }
    if (sub[0] === 'commits' && method === 'GET') {
      const ref = q.get('sha') ?? repo.defaultBranch;
      let tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
      if (!tip && isSha(ref)) tip = ref;
      if (!tip) tip = branchTip(repo, repo.defaultBranch);
      const list = commitsFrom(repo, tip).map((c) => ({
        sha: c.sha, commit: { message: c.message, author: { name: 'Forge', email: 'forge@example.invalid' }, committer: { name: 'Forge', email: 'forge@example.invalid' } },
        author: { login: viewerLogin ?? '' }, committer: { login: viewerLogin ?? '' },
      }));
      ok(200, list); return true;
    }
    if (sub[0] === 'git' && sub[1] === 'refs') {
      if (method === 'POST') {
        const ref = String(b.ref ?? '');
        const sha = String(b.sha ?? '');
        if (!ref.startsWith('refs/') || !isSha(sha)) { err(422, 'Invalid ref or sha'); return true; }
        repo.refs.set(ref, sha);
        ok(201, { ref, object: { sha, type: 'commit' }, url: '' }); return true;
      }
      if (method === 'GET') {
        const refName = sub.slice(2).join('/');
        const sha = repo.refs.get(refName) ?? repo.refs.get(`refs/${refName}`);
        if (!sha) { err(404, 'Not Found'); return true; }
        ok(200, { ref: refName, object: { sha, type: 'commit' } }); return true;
      }
    }
    if (sub[0] === 'contents') {
      const filePath = sub.slice(1).join('/');
      const branch = q.get('ref') ?? (typeof b.branch === 'string' ? b.branch : repo.defaultBranch);
      if (method === 'GET') {
        const files = filesAt(repo, branch);
        if (filePath === '' || !files.has(filePath)) {
          // directory listing (or root)
          const dir = filePath === '' ? '' : `${filePath}/`;
          const entries: Array<Record<string, unknown>> = [];
          const seenDirs = new Set<string>();
          for (const [p, f] of files) {
            if (!p.startsWith(dir)) continue;
            const restPath = p.slice(dir.length);
            const slash = restPath.indexOf('/');
            if (slash < 0) entries.push({ type: 'file', name: restPath, path: p, sha: f.oid, size: repo.objects.get(f.oid)?.data.length ?? 0 });
            else {
              const d = restPath.slice(0, slash);
              if (!seenDirs.has(d)) { seenDirs.add(d); entries.push({ type: 'dir', name: d, path: `${dir}${d}`, sha: '0000000000000000000000000000000000000000' }); }
            }
          }
          if (filePath !== '' && files.has(filePath)) { /* handled below */ }
          if (entries.length === 0 && filePath !== '') { err(404, 'Not Found'); return true; }
          if (filePath === '') { ok(200, entries); return true; }
          // If it is a file, fall through to file response.
          if (files.has(filePath)) {
            const f = files.get(filePath)!;
            const data = repo.objects.get(f.oid)?.data ?? Buffer.alloc(0);
            ok(200, { type: 'file', encoding: 'base64', content: b64(data), sha: f.oid, size: data.length, name: filePath.split('/').pop(), path: filePath });
            return true;
          }
          ok(200, entries); return true;
        }
        const f = files.get(filePath)!;
        const data = repo.objects.get(f.oid)?.data ?? Buffer.alloc(0);
        ok(200, { type: 'file', encoding: 'base64', content: b64(data), sha: f.oid, size: data.length, name: filePath.split('/').pop(), path: filePath });
        return true;
      }
      if (method === 'PUT') {
        const contentB64 = String(b.content ?? '');
        if (typeof b.message !== 'string' || contentB64 === '') { err(422, 'message and content are required'); return true; }
        const bytes = unb64(contentB64);
        const blobOid = objId('blob', bytes);
        repo.objects.set(blobOid, { type: 'blob', data: bytes });
        const targetBranch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const files = filesAt(repo, targetBranch);
        const existing = files.get(filePath);
        const isUpdate = !!existing;
        if (isUpdate) {
          if (typeof b.sha === 'string' && b.sha !== existing!.oid) { err(409, 'sha does not match'); return true; }
        }
        files.set(filePath, { oid: blobOid, mode: '100644' });
        const parents = branchTip(repo, targetBranch) ? [branchTip(repo, targetBranch)!] : [];
        const c = commitFiles(repo, files, String(b.message), parents);
        repo.refs.set(`refs/heads/${targetBranch}`, c.oid);
        ok(isUpdate ? 200 : 201, { content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, encoding: 'base64', size: bytes.length }, commit: { sha: c.oid, message: String(b.message) } });
        return true;
      }
      if (method === 'DELETE') {
        const files = filesAt(repo, repo.defaultBranch);
        if (!files.has(filePath)) { err(404, 'Not Found'); return true; }
        files.delete(filePath);
        const parents = branchTip(repo, repo.defaultBranch) ? [branchTip(repo, repo.defaultBranch)!] : [];
        const c = commitFiles(repo, files, String(b.message ?? 'Delete file'), parents);
        repo.refs.set(`refs/heads/${repo.defaultBranch}`, c.oid);
        ok(200, { commit: { sha: c.oid } }); return true;
      }
    }
    if (sub[0] === 'labels' && method === 'POST') {
      const name = String(b.name ?? '');
      if (!name) { err(422, 'name is required'); return true; }
      repo.labels.set(name, { name, color: typeof b.color === 'string' ? b.color : 'ededed' });
      ok(201, { name, color: repo.labels.get(name)!.color }); return true;
    }
    if (sub[0] === 'issues') {
      if (sub.length === 1) {
        if (method === 'POST') {
          const labels: string[] = Array.isArray(b.labels) ? b.labels.map((x) => typeof x === 'string' ? x : String((x as Record<string, unknown>).name ?? '')) : [];
          for (const l of labels) if (!repo.labels.has(l)) { err(422, `Label does not exist: ${l}`); return true; }
          const iss: Issue = { number: repo.nextIssue++, title: String(b.title ?? ''), body: String(b.body ?? ''), state: 'open', labels, seq: globalSeq++, id: 10000 + repo.id * 100 + repo.nextIssue, comments: [] };
          repo.issues.push(iss);
          ok(201, issueJson(repo, iss)); return true;
        }
        if (method === 'GET') {
          let list = [...repo.issues];
          const state = q.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const sort = q.get('sort') ?? 'created';
          const dir = q.get('direction') ?? (sort === 'created' ? 'desc' : 'desc');
          if (sort === 'created') list.sort((a, c2) => dir === 'asc' ? a.seq - c2.seq : c2.seq - a.seq);
          const { page, link } = paginate(list.map((i) => issueJson(repo, i)), q, origin, path);
          ok(200, page, link ? { link } : {}); return true;
        }
      }
      const num = Number(sub[1]);
      const iss = repo.issues.find((i) => i.number === num);
      if (!iss) { err(404, 'Not Found'); return true; }
      if (sub.length === 2) {
        if (method === 'GET') { ok(200, issueJson(repo, iss)); return true; }
        if (method === 'PATCH') {
          if (b.state === 'open' || b.state === 'closed') iss.state = b.state;
          if (typeof b.title === 'string') iss.title = b.title;
          if (typeof b.body === 'string') iss.body = b.body;
          ok(200, issueJson(repo, iss)); return true;
        }
      }
      if (sub[2] === 'comments') {
        if (method === 'POST') {
          const cm = { id: repo.nextComment++, body: String(b.body ?? '') };
          iss.comments.push(cm);
          ok(201, cm); return true;
        }
        if (method === 'GET') { ok(200, iss.comments); return true; }
      }
    }
    if (sub[0] === 'pulls') {
      if (sub.length === 1) {
        if (method === 'POST') {
          const head = String(b.head ?? '');
          const base = String(b.base ?? repo.defaultBranch);
          const headSha = branchTip(repo, head) ?? ZERO_OID;
          const baseSha = branchTip(repo, base) ?? ZERO_OID;
          const baseFiles = filesAt(repo, base);
          const headFiles = filesAt(repo, head);
          const p: Pull = {
            number: repo.nextPull++, title: String(b.title ?? ''), body: String(b.body ?? ''), state: 'open',
            head, base, headSha, baseSha, merged: false, mergedAt: '', mergeSha: '', seq: globalSeq++,
            id: 20000 + repo.id * 100 + repo.nextPull, files: diffFiles(baseFiles, headFiles),
          };
          repo.pulls.push(p);
          ok(201, pullJson(repo, p)); return true;
        }
        if (method === 'GET') {
          let list = [...repo.pulls];
          const state = q.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((x) => x.state === state);
          const { page, link } = paginate(list.map((x) => pullJson(repo, x)), q, origin, path);
          ok(200, page, link ? { link } : {}); return true;
        }
      }
      const num = Number(sub[1]);
      const p = repo.pulls.find((x) => x.number === num);
      if (!p) { err(404, 'Not Found'); return true; }
      if (sub.length === 2 && method === 'GET') { ok(200, pullJson(repo, p)); return true; }
      if (sub[2] === 'files' && method === 'GET') { ok(200, p.files); return true; }
      if (sub[2] === 'merge' && method === 'PUT') {
        if (p.merged) { ok(200, { sha: p.mergeSha, merged: true, message: 'Pull request already merged' }); return true; }
        const curBaseTip = branchTip(repo, p.base) ?? ZERO_OID;
        const curHeadTip = branchTip(repo, p.head) ?? p.headSha;
        const mb = mergeBase(repo, curBaseTip, curHeadTip);
        const mbFiles = new Map<string, { oid: string; mode: string }>();
        if (mb) { const o = repo.objects.get(mb); if (o && o.type === 'commit') flattenTree(repo, parseCommit(o.data).tree, '', mbFiles); }
        const headFiles = filesAt(repo, p.head);
        const baseFiles = filesAt(repo, p.base);
        // conflict: a path changed on both sides of the merge-base with different bytes
        let conflict = false;
        for (const [pathName, h] of headFiles) {
          const m = mbFiles.get(pathName);
          const cur = baseFiles.get(pathName);
          if (m && h.oid !== m.oid && cur && cur.oid !== m.oid && cur.oid !== h.oid) { conflict = true; break; }
        }
        if (!conflict) {
          for (const [pathName, m] of mbFiles) {
            if (!headFiles.has(pathName) && baseFiles.has(pathName) && baseFiles.get(pathName)!.oid !== m.oid) { conflict = true; break; }
          }
        }
        if (conflict) { err(405, 'Merge conflict'); return true; }
        const result = new Map(baseFiles);
        for (const [pathName, h] of headFiles) result.set(pathName, h);
        for (const [pathName] of mbFiles) if (!headFiles.has(pathName)) result.delete(pathName);
        const c = commitFiles(repo, result, p.title || `Merge pull request #${p.number}`, curBaseTip !== ZERO_OID ? [curBaseTip] : []);
        repo.refs.set(`refs/heads/${p.base}`, c.oid);
        p.state = 'closed'; p.merged = true; p.mergedAt = '2026-01-01T00:00:00Z'; p.mergeSha = c.oid;
        ok(200, { sha: c.oid, merged: true, message: `Merge pull request #${p.number}` }); return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- GraphQL
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'databaseId'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'headRefOid', 'baseRefOid', 'createdAt', 'updatedAt', 'author', 'url', 'databaseId'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt'],
  SearchType: [],
};
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'];
function gqlIssue(r: Repo, iss: Issue): Record<string, unknown> {
  return { id: gid('issue', r, iss.number), databaseId: iss.id, number: iss.number, title: iss.title, body: iss.body, state: iss.state.toUpperCase(), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
}
function gqlPull(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: gid('pull', r, p.number), databaseId: p.id, number: p.number, title: p.title, body: p.body,
    state: p.state.toUpperCase(), headRefName: p.head, baseRefName: p.base,
    mergeable: isPullConflicted(r, p) ? 'CONFLICTING' : 'MERGEABLE', merged: p.merged,
    headRefOid: p.headSha, baseRefOid: p.baseSha,
    files: { nodes: p.files.map((f) => ({ path: f.filename })), totalCount: p.files.length },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}
function gqlRepo(r: Repo): Record<string, unknown> {
  return {
    id: gid('repo', r), databaseId: r.id, name: r.name,
    nameWithOwner: `${r.owner ?? viewerLogin ?? ''}/${r.name}`,
    owner: { login: r.owner ?? viewerLogin ?? '', id: 1000 },
    defaultBranchRef: { name: r.defaultBranch, target: { oid: branchTip(r, r.defaultBranch) ?? ZERO_OID } },
    viewerPermission: 'ADMIN', hasIssuesEnabled: true, description: r.description, isPrivate: r.priv,
    url: `/api/v3/repos/${r.owner ?? ''}/${r.name}`,
  };
}
function isPullConflicted(r: Repo, p: Pull): boolean {
  if (p.merged) return false;
  const curBaseTip = branchTip(r, p.base) ?? ZERO_OID;
  const curHeadTip = branchTip(r, p.head) ?? p.headSha;
  const mb = mergeBase(r, curBaseTip, curHeadTip);
  if (!mb) return false;
  const mbFiles = new Map<string, { oid: string; mode: string }>();
  const o = r.objects.get(mb);
  if (o && o.type === 'commit') flattenTree(r, parseCommit(o.data).tree, '', mbFiles);
  const headFiles = filesAt(r, p.head);
  const baseFiles = filesAt(r, p.base);
  for (const [pathName, h] of headFiles) {
    const m = mbFiles.get(pathName); const cur = baseFiles.get(pathName);
    if (m && h.oid !== m.oid && cur && cur.oid !== m.oid && cur.oid !== h.oid) return true;
  }
  for (const [pathName, m] of mbFiles) {
    if (!headFiles.has(pathName) && baseFiles.has(pathName) && baseFiles.get(pathName)!.oid !== m.oid) return true;
  }
  return false;
}
function doMergePull(r: Repo, p: Pull): { status: 'ok' | 'conflict' | 'already'; sha?: string } {
  if (p.merged) return { status: 'already', sha: p.mergeSha };
  if (isPullConflicted(r, p)) return { status: 'conflict' };
  const curBaseTip = branchTip(r, p.base) ?? ZERO_OID;
  const mb = mergeBase(r, curBaseTip, branchTip(r, p.head) ?? p.headSha);
  const mbFiles = new Map<string, { oid: string; mode: string }>();
  if (mb) { const o = r.objects.get(mb); if (o && o.type === 'commit') flattenTree(r, parseCommit(o.data).tree, '', mbFiles); }
  const headFiles = filesAt(r, p.head);
  const result = new Map(filesAt(r, p.base));
  for (const [pathName, h] of headFiles) result.set(pathName, h);
  for (const [pathName] of mbFiles) if (!headFiles.has(pathName)) result.delete(pathName);
  const c = commitFiles(r, result, p.title || `Merge pull request #${p.number}`, curBaseTip !== ZERO_OID ? [curBaseTip] : []);
  r.refs.set(`refs/heads/${p.base}`, c.oid);
  p.state = 'closed'; p.merged = true; p.mergedAt = '2026-01-01T00:00:00Z'; p.mergeSha = c.oid;
  return { status: 'ok', sha: c.oid };
}
function decodeGid(g: string): { kind: string; repoId: number; num: number } | null {
  try {
    const s = Buffer.from(g, 'base64').toString('utf8');
    const parts = s.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], repoId: Number(parts[1]), num: Number(parts[2] ?? 0) };
  } catch { return null; }
}
function repoByGid(g: string): Repo | null {
  const d = decodeGid(g);
  if (!d) return null;
  for (const r of repos.values()) if (r.id === d.repoId) return r;
  return null;
}
function execGraphQL(query: string, vars: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  const data: Record<string, unknown> = {};
  const q = query;
  // Introspection __type
  const typeMatches = [...q.matchAll(/__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g)];
  if (typeMatches.length) {
    // Aliases: `Alias: __type(...)` — capture alias per occurrence.
    const aliasRe = /(?:(\w+)\s*:\s*)?__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g;
    for (const m of q.matchAll(aliasRe)) {
      const alias = m[1] ?? m[2];
      const typeName = m[2];
      if (typeName === 'SearchType') {
        data[alias] = { name: 'SearchType', enumValues: SEARCH_ENUM.map((n) => ({ name: n })) };
      } else {
        data[alias] = { name: typeName, fields: (TYPE_FIELDS[typeName] ?? []).map((n) => ({ name: n })) };
      }
    }
    return { data };
  }
  // Unknown-field probe: viewer { noSuchFieldOnViewer }
  if (/noSuchFieldOnViewer/.test(q)) {
    errors.push({ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' });
    data.viewer = null;
    return { data, errors };
  }
  // viewer { login }
  if (/viewer\s*\{/.test(q) && !/repository\s*\(/.test(q)) {
    data.viewer = { login: viewerLogin ?? '' };
    return { data };
  }
  // node(id:)
  if (/node\s*\(/.test(q)) {
    const id = String(vars.id ?? '');
    const r = repoByGid(id);
    if (r) data.node = { id: gid('repo', r), name: r.name, nameWithOwner: `${r.owner ?? viewerLogin ?? ''}/${r.name}` };
    else data.node = null;
    return { data };
  }
  // repository(owner:, name:) — mutations and queries share this root
  if (/repository\s*\(/.test(q) || /createIssue|closeIssue|createPullRequest|mergePullRequest|addComment/.test(q)) {
    return execRepoGraphQL(q, vars, data, errors);
  }
  if (/viewer/.test(q)) {
    data.viewer = { login: viewerLogin ?? '' };
    return { data };
  }
  errors.push({ message: 'Cannot query field on type "Query".' });
  return { data, errors };
}
function execRepoGraphQL(q: string, vars: Record<string, unknown>, data: Record<string, unknown>, errors: Array<{ message: string }>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  // Mutations first.
  if (/createIssue/.test(q)) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const r = repoByGid(String(input.repositoryId ?? ''));
    if (!r) { errors.push({ message: 'Repository not found.' }); return { data, errors }; }
    const iss: Issue = { number: r.nextIssue++, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', labels: [], seq: globalSeq++, id: 10000 + r.id * 100 + r.nextIssue, comments: [] };
    r.issues.push(iss);
    data.createIssue = { issue: { number: iss.number, id: gid('issue', r, iss.number) } };
    return { data };
  }
  if (/closeIssue/.test(q)) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const d = decodeGid(String(input.issueId ?? ''));
    const r = d ? [...repos.values()].find((x) => x.id === d.repoId) : undefined;
    const iss = r?.issues.find((i) => i.number === d?.num);
    if (!r || !iss) { errors.push({ message: 'Issue not found.' }); return { data, errors }; }
    iss.state = 'closed';
    data.closeIssue = { issue: { number: iss.number, id: gid('issue', r, iss.number), state: 'CLOSED' } };
    return { data };
  }
  if (/createPullRequest/.test(q)) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const r = repoByGid(String(input.repositoryId ?? ''));
    if (!r) { errors.push({ message: 'Repository not found.' }); return { data, errors }; }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? r.defaultBranch);
    const headSha = branchTip(r, head) ?? ZERO_OID;
    const baseSha = branchTip(r, base) ?? ZERO_OID;
    const p: Pull = {
      number: r.nextPull++, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open',
      head, base, headSha, baseSha, merged: false, mergedAt: '', mergeSha: '', seq: globalSeq++,
      id: 20000 + r.id * 100 + r.nextPull, files: diffFiles(filesAt(r, base), filesAt(r, head)),
    };
    r.pulls.push(p);
    data.createPullRequest = { pullRequest: { number: p.number, id: gid('pull', r, p.number), state: 'OPEN', headRefName: head, baseRefName: base } };
    return { data };
  }
  if (/mergePullRequest/.test(q)) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const d = decodeGid(String(input.pullRequestId ?? ''));
    const r = d ? [...repos.values()].find((x) => x.id === d.repoId) : undefined;
    const p = r?.pulls.find((x) => x.number === d?.num);
    if (!r || !p) { errors.push({ message: 'Pull request not found.' }); return { data, errors }; }
    const res = doMergePull(r, p);
    if (res.status === 'conflict') { errors.push({ message: 'Merge conflict.' }); return { data, errors }; }
    data.mergePullRequest = { pullRequest: { number: p.number, merged: true, state: 'CLOSED' } };
    return { data };
  }
  if (/addComment/.test(q)) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const d = decodeGid(String(input.subjectId ?? ''));
    const r = d ? [...repos.values()].find((x) => x.id === d.repoId) : undefined;
    const iss = r?.issues.find((i) => i.number === d?.num);
    if (!r || !iss) { errors.push({ message: 'Issue not found.' }); return { data, errors }; }
    const cm = { id: r.nextComment++, body: String(input.body ?? '') };
    iss.comments.push(cm);
    data.addComment = { commentEdge: { node: { id: gid('comment', r, cm.id), body: cm.body } } };
    return { data };
  }
  // Queries with repository(owner, name)
  const owner = String(vars.owner ?? '');
  const name = String(vars.name ?? '');
  learnOwner(owner);
  const r = lookupRepo(owner, name);
  if (!r) { data.repository = null; return { data }; }
  const repoOut: Record<string, unknown> = gqlRepo(r);
  // issues connection
  if (/issues\s*\(/.test(q)) {
    const first = Number(vars.first ?? 10) || 10;
    const after = typeof vars.after === 'string' && vars.after ? Number(Buffer.from(vars.after, 'base64').toString('utf8').replace('cursor:', '')) : 0;
    const statesOpen = /states\s*:\s*\[OPEN\]/.test(q);
    const desc = /direction\s*:\s*DESC/.test(q);
    let list = [...r.issues];
    if (statesOpen) list = list.filter((i) => i.state === 'open');
    list.sort((a, b) => desc ? b.seq - a.seq : a.seq - b.seq);
    // cursor paging is in creation (asc) order for the pagination check; DESC list has no cursor.
    const pageList = /after/.test(q) ? list.filter((i) => i.number > after) : list;
    const page = pageList.slice(0, first);
    const lastNum = page.length ? page[page.length - 1].number : 0;
    repoOut.issues = {
      nodes: page.map((i) => gqlIssue(r, i)),
      pageInfo: { hasNextPage: pageList.length > first, endCursor: Buffer.from(`cursor:${lastNum}`).toString('base64') },
      totalCount: list.length,
    };
  }
  if (/issue\s*\(/.test(q)) {
    const num = Number(vars.number ?? 0);
    const iss = r.issues.find((i) => i.number === num);
    repoOut.issue = iss ? gqlIssue(r, iss) : null;
  }
  if (/pullRequests\s*\(/.test(q)) {
    const first = Number(vars.first ?? 5) || 5;
    const list = r.pulls.filter((p) => p.state === 'open').slice(0, first);
    repoOut.pullRequests = { nodes: list.map((p) => gqlPull(r, p)), totalCount: r.pulls.length };
  }
  if (/pullRequest\s*\(/.test(q)) {
    const num = Number(vars.number ?? 0);
    const p = r.pulls.find((x) => x.number === num);
    repoOut.pullRequest = p ? gqlPull(r, p) : null;
  }
  data.repository = repoOut;
  return { data };
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): Promise<boolean> {
  const rid = reqId();
  const headers: Record<string, string> = { 'x-github-request-id': rid };
  if (!authOk(req)) { sendJson(res, 401, { message: 'Requires authentication' }, headers); return true; }
  let parsed: unknown;
  try { parsed = JSON.parse(bodyBuf.toString('utf8')); }
  catch { sendJson(res, 400, { message: 'Problems parsing JSON' }, headers); return true; }
  const runOne = (op: unknown): Record<string, unknown> => {
    if (typeof op !== 'object' || op === null) return { data: {}, errors: [{ message: 'Invalid operation.' }] };
    const rec = op as Record<string, unknown>;
    const query = String(rec.query ?? '');
    const vars = (rec.variables ?? {}) as Record<string, unknown>;
    const { data, errors } = execGraphQL(query, vars);
    return errors && errors.length ? { data, errors } : { data };
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne), headers);
    return true;
  }
  sendJson(res, 200, runOne(parsed), headers);
  return true;
}

// ---------------------------------------------------------------- MCP
interface McpToolDef { name: string; description: string; properties: Record<string, { type: string; description: string }>; required: string[]; }
const MCP_TOOLS: McpToolDef[] = [
  { name: 'create_repo', description: 'Create a repository owned by the viewer.', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['name'] },
  { name: 'get_repo', description: 'Get a repository by owner and name.', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo'] },
  { name: 'create_issue', description: 'Create an issue in a repository.', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo', 'title'] },
  { name: 'list_issues', description: 'List issues in a repository.', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed or all' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo'] },
  { name: 'create_pull_request', description: 'Create a pull request from a head branch to a base branch.', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  { name: 'merge_pull_request', description: 'Merge a pull request by number.', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo', 'pull_number'] },
];
const MCP_TOOLS_JSON = MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.properties, required: t.required } }));
function mcpRepoFromArgs(args: Record<string, unknown>): Repo | null {
  const full = typeof args.full_name === 'string' ? args.full_name : '';
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : (typeof args.name === 'string' ? args.name : '');
  if (full.includes('/')) { const [o, n] = full.split('/'); if (!owner) owner = o; if (!name) name = n; }
  if (!owner || !name) return null;
  learnOwner(owner);
  return lookupRepo(owner, name);
}
function mcpToolResult(payload: unknown, isError = false): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError };
}
function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tool = MCP_TOOLS.find((t) => norm === t.name.replace(/[^a-z0-9]/g, '') || norm.endsWith(t.name.replace(/[^a-z0-9]/g, '')));
  if (!tool) return { error: { code: -32601, message: `Method not found: ${name}` } };
  const missing = tool.required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (missing.length) return { result: mcpToolResult({ error: `Missing required argument(s): ${missing.join(', ')}` }, true) };
  try {
    if (tool.name === 'create_repo') {
      const nm = String(args.name);
      const existing = repos.get(nm);
      const r = existing ?? createRepo(nm, args.private === true, typeof args.description === 'string' ? args.description : '');
      return { result: mcpToolResult(repoJson(r)) };
    }
    if (tool.name === 'get_repo') {
      const r = mcpRepoFromArgs(args);
      if (!r) return { result: mcpToolResult({ error: 'Repository not found' }, true) };
      return { result: mcpToolResult(repoJson(r)) };
    }
    if (tool.name === 'create_issue') {
      const r = mcpRepoFromArgs(args);
      if (!r) return { result: mcpToolResult({ error: 'Repository not found' }, true) };
      const iss: Issue = { number: r.nextIssue++, title: String(args.title ?? ''), body: String(args.body ?? ''), state: 'open', labels: [], seq: globalSeq++, id: 10000 + r.id * 100 + r.nextIssue, comments: [] };
      r.issues.push(iss);
      return { result: mcpToolResult(issueJson(r, iss)) };
    }
    if (tool.name === 'list_issues') {
      const r = mcpRepoFromArgs(args);
      if (!r) return { result: mcpToolResult({ error: 'Repository not found' }, true) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = state === 'all' ? r.issues : r.issues.filter((i) => i.state === state);
      return { result: mcpToolResult({ issues: list.map((i) => issueJson(r, i)) }) };
    }
    if (tool.name === 'create_pull_request') {
      const r = mcpRepoFromArgs(args);
      if (!r) return { result: mcpToolResult({ error: 'Repository not found' }, true) };
      const head = String(args.head ?? '');
      const base = String(args.base ?? r.defaultBranch);
      const p: Pull = {
        number: r.nextPull++, title: String(args.title ?? ''), body: String(args.body ?? ''), state: 'open',
        head, base, headSha: branchTip(r, head) ?? ZERO_OID, baseSha: branchTip(r, base) ?? ZERO_OID,
        merged: false, mergedAt: '', mergeSha: '', seq: globalSeq++,
        id: 20000 + r.id * 100 + r.nextPull, files: diffFiles(filesAt(r, base), filesAt(r, head)),
      };
      r.pulls.push(p);
      return { result: mcpToolResult(pullJson(r, p)) };
    }
    if (tool.name === 'merge_pull_request') {
      const r = mcpRepoFromArgs(args);
      if (!r) return { result: mcpToolResult({ error: 'Repository not found' }, true) };
      const num = Number(args.pull_number ?? 0);
      const p = r.pulls.find((x) => x.number === num);
      if (!p) return { result: mcpToolResult({ error: 'Pull request not found' }, true) };
      const res = doMergePull(r, p);
      if (res.status === 'conflict') return { result: mcpToolResult({ error: 'Merge conflict' }, true) };
      return { result: mcpToolResult({ ...pullJson(r, p), sha: res.sha, merged: true }) };
    }
  } catch (e) {
    return { result: mcpToolResult({ error: e instanceof Error ? e.message : String(e) }, true) };
  }
  return { error: { code: -32601, message: `Method not found: ${name}` } };
}
async function handleMcp(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): Promise<boolean> {
  if ((req.method ?? 'GET') === 'DELETE') { res.writeHead(202); res.end(); return true; }
  let parsed: unknown;
  try { parsed = JSON.parse(bodyBuf.toString('utf8')); }
  catch {
    const body = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    res.writeHead(400, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (!authOk(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return true; }
  const rec = parsed as Record<string, unknown>;
  const id = rec.id === undefined ? null : rec.id;
  const method = String(rec.method ?? '');
  const params = (rec.params ?? {}) as Record<string, unknown>;
  // Notification (no id): 202, no body.
  if (rec.id === undefined) { res.writeHead(202); res.end(); return true; }
  const reply = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const replyErr = (code: number, message: string): void => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') {
    const pv = typeof (params.protocolVersion as string) === 'string' ? String(params.protocolVersion) : '2026-07-28';
    const ver = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(pv) ? pv : '2026-07-28';
    res.setHeader('mcp-session-id', 'forge-session-1');
    reply({ protocolVersion: ver, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'github-forge', version: '1.0.0' } });
    return true;
  }
  if (method === 'server/discover') {
    reply({ protocolVersion: '2026-07-28', supportedVersions: ['2026-07-28', '2025-11-25'], serverInfo: { name: 'github-forge', version: '1.0.0' }, capabilities: { tools: {}, resources: {}, prompts: {} } });
    return true;
  }
  if (method === 'tools/list') {
    reply({ tools: MCP_TOOLS_JSON });
    return true;
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const out = mcpCallTool(name, args);
    if (out.error) { replyErr((out.error as { code: number }).code, (out.error as { message: string }).message); return true; }
    reply(out.result);
    return true;
  }
  if (method === 'ping') { reply({}); return true; }
  replyErr(-32601, `Method not found: ${method}`);
  return true;
}

// ---------------------------------------------------------------- git smart HTTP
function pkt(s: string): Buffer {
  const len = Buffer.byteLength(s) + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), Buffer.from(s, 'utf8')]);
}
const FLUSH = Buffer.from('0000', 'utf8');
function pktLines(lines: string[]): Buffer {
  return Buffer.concat([...lines.map(pkt), FLUSH]);
}
function parsePktLines(buf: Buffer): string[] {
  const out: string[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = parseInt(buf.subarray(pos, pos + 4).toString('utf8'), 16);
    if (Number.isNaN(len) || len === 0) { pos += 4; continue; }
    if (len === 1) { pos += 4; continue; }
    out.push(buf.subarray(pos + 4, pos + len).toString('utf8'));
    pos += len;
  }
  return out;
}
// Split a body into pkt-line section (up to first flush) and the remainder (packfile).
function splitPktSection(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const lenHex = buf.subarray(pos, pos + 4).toString('utf8');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { pos += 4; break; }
    if (len === 1) { pos += 4; continue; }
    lines.push(buf.subarray(pos + 4, pos + len).toString('utf8'));
    pos += len;
  }
  return { lines, rest: buf.subarray(pos) };
}
function refLines(r: Repo, caps: string): Buffer {
  const parts: Buffer[] = [];
  const refs = [...r.refs.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  const headTip = branchTip(r, r.defaultBranch);
  const headOid = headTip ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${headOid} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) parts.push(pkt(`${oid} ${ref}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515; // pkt-line total (4 len + 1 band + data) must stay <= 65520
  for (let i = 0; i < pack.length; i += CHUNK) {
    const data = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    const len = data.length + 5;
    parts.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), Buffer.from([1]), data]));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
function sidebandText(text: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += 65515) {
    const chunk = data.subarray(i, Math.min(data.length, i + 65515));
    const len = chunk.length + 5;
    parts.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), Buffer.from([1]), chunk]));
  }
  return Buffer.concat(parts);
}
// Depth-limited fetch object selection (protocol v2/v0 shallow support).
function fetchObjects(repo: Repo, wants: string[], haves: Set<string>, depth: number | null, shallowArgs: string[]): { objects: Map<string, GitObj>; shallow: string[]; unshallow: string[] } {
  const shallowSet = new Set(shallowArgs);
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
  const maxDepth = depth ?? Infinity;
  while (queue.length) {
    const [oid, d] = queue.shift()!;
    if (dist.has(oid) && dist.get(oid)! <= d) continue;
    dist.set(oid, d);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      if (d + 1 >= maxDepth) continue;
      if (depth === null && shallowSet.has(oid)) continue;
      for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (m) queue.push([m[1], d]);
    }
  }
  const included = new Map<string, GitObj>();
  const addClosure = (oid: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || included.has(oid)) return;
    included.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      addClosure(c.tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) addClosure(e.oid);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (m) addClosure(m[1]);
    }
  };
  for (const [oid, d] of dist) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit' && d >= maxDepth) continue;
    if (obj.type === 'commit') addClosure(oid);
    else addClosure(oid);
  }
  // Subtract everything the client already has. A have that is also a shallow
  // boundary is held without its parents, so the closure stops there.
  if (haves.size) {
    const held = new Set<string>();
    const hstack = [...haves];
    while (hstack.length) {
      const oid = hstack.pop()!;
      if (held.has(oid)) continue;
      held.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        held.add(c.tree);
        if (!shallowSet.has(oid)) for (const p of c.parents) hstack.push(p);
        // trees/blobs under the tree are held too: walk the tree.
        const tstack = [c.tree];
        while (tstack.length) {
          const t = tstack.pop()!;
          const tobj = repo.objects.get(t);
          if (!tobj || tobj.type !== 'tree') continue;
          for (const e of parseTree(tobj.data)) { held.add(e.oid); if (e.mode === '40000') tstack.push(e.oid); }
        }
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) held.add(e.oid);
      } else if (obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
        if (m) hstack.push(m[1]);
      }
    }
    for (const oid of held) included.delete(oid);
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null || shallowArgs.length) {
    for (const [oid, d] of dist) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (d === maxDepth - 1) shallow.push(oid);
    }
    for (const s of shallowArgs) {
      const d = dist.get(s);
      if (d === undefined) continue;
      if (d < maxDepth - 1) unshallow.push(s);
      else if (d === maxDepth - 1 && !shallow.includes(s)) shallow.push(s);
    }
  }
  return { objects: included, shallow: [...new Set(shallow)], unshallow: [...new Set(unshallow)] };
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams, bodyBuf: Buffer): Promise<boolean> {
  const method = req.method ?? 'GET';
  const m = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (!m) return false;
  const owner = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  const sub = m[3];
  if (!authOk(req)) { jsonErr(res, 401, 'Requires authentication'); return true; }
  learnOwner(owner);
  const r = lookupRepo(owner, name);
  if (!r) { jsonErr(res, 404, 'Not Found'); return true; }
  const repo = r;
  if (sub === 'info/refs' && method === 'GET') {
    const service = q.get('service') ?? '';
    const proto = (req.headers['git-protocol'] ?? '') as string;
    if (service === 'git-upload-pack' && proto.includes('version=2')) {
      const adv = Buffer.concat([
        pkt('version 2\n'),
        pkt('ls-refs=unborn\n'), pkt('fetch=shallow wait-for-done\n'), pkt('server-option\n'), pkt('object-format=sha1\n'), pkt('agent=github-forge/1.0\n'),
        FLUSH,
      ]);
      sendRaw(res, 200, adv, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-upload-pack') {
      const pre = Buffer.concat([pkt('# service=git-upload-pack\n'), FLUSH]);
      sendRaw(res, 200, Buffer.concat([pre, refLines(repo, 'side-band-64k thin-pack ofs-delta shallow multi_ack agent=github-forge/1.0')]), 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      const pre = Buffer.concat([pkt('# service=git-receive-pack\n'), FLUSH]);
      sendRaw(res, 200, Buffer.concat([pre, refLines(repo, 'report-status side-band-64k delete-refs ofs-delta agent=github-forge/1.0')]), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    jsonErr(res, 404, 'Not Found'); return true;
  }
  if (sub === 'git-upload-pack' && method === 'POST') {
    const proto = (req.headers['git-protocol'] ?? '') as string;
    if (proto.includes('version=2')) {
      // v2: `command=<name>` pkt-line, optional agent/object-format lines, delim 0001,
      // then args, then flush.
      const all = parsePktLines(bodyBuf);
      const cmdLine = (all[0] ?? '').trim();
      const cmd = cmdLine.startsWith('command=') ? cmdLine.slice('command='.length) : cmdLine;
      const args = all.slice(1);
      if (cmd === 'ls-refs') {
        const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length).trim());
        const peel = args.some((a) => a.trim() === 'peel');
        const symrefs = args.some((a) => a.trim() === 'symrefs');
        const unborn = args.some((a) => a.trim() === 'unborn');
        const out: Buffer[] = [];
        const refs = [...repo.refs.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
        const keep = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
        if (refs.length === 0) {
          if (unborn) out.push(pkt(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
        } else {
          const headTip = branchTip(repo, repo.defaultBranch) ?? ZERO_OID;
          if (symrefs && keep('HEAD')) out.push(pkt(`${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
          for (const [ref, oid] of refs) {
            if (!keep(ref)) continue;
            let line = `${oid} ${ref}`;
            if (peel) {
              const obj = repo.objects.get(oid);
              if (obj && obj.type === 'tag') {
                const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
                if (m) line += ` peeled:${m[1]}`;
              }
            }
            out.push(pkt(`${line}\n`));
          }
        }
        out.push(FLUSH);
        sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
        return true;
      }
      if (cmd === 'fetch') {
        const wants: string[] = [];
        const haves = new Set<string>();
        const shallowArgs: string[] = [];
        let depth: number | null = null;
        for (const a of args) {
          const t = a.trim();
          if (t.startsWith('want ')) wants.push(t.slice(5).trim());
          else if (t.startsWith('have ')) haves.add(t.slice(5).trim());
          else if (t.startsWith('shallow ')) shallowArgs.push(t.slice(8).trim());
          else if (t.startsWith('deepen ')) { const n = Number(t.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
          else if (t === 'done') break;
        }
        const { objects, shallow, unshallow } = fetchObjects(repo, wants, haves, depth, shallowArgs);
        const pack = buildPack(objects);
        const sections: Buffer[] = [];
        if (haves.size) {
          const ackLines: Buffer[] = [pkt('acknowledgments\n')];
          const missing = [...haves].filter((h) => !repo.objects.has(h));
          if (missing.length) ackLines.push(pkt('NAK\n'));
          else {
            for (const h of haves) ackLines.push(pkt(`ACK ${h}\n`));
            ackLines.push(pkt('ready\n'));
          }
          ackLines.push(FLUSH);
          sections.push(Buffer.concat(ackLines));
        }
        if (depth !== null || shallowArgs.length) {
          const si: Buffer[] = [pkt('shallow-info\n')];
          for (const s of shallow) si.push(pkt(`shallow ${s}\n`));
          for (const s of unshallow) si.push(pkt(`unshallow ${s}\n`));
          si.push(FLUSH);
          sections.push(Buffer.concat(si));
        }
        sections.push(Buffer.concat([pkt('packfile\n'), sidebandPack(pack)]));
        sendRaw(res, 200, Buffer.concat(sections), 'application/x-git-upload-pack-result');
        return true;
      }
      sendRaw(res, 200, pktLines([]), 'application/x-git-upload-pack-result');
      return true;
    }
    // v0 upload-pack: wants section, flush, then have/done section; sideband pack.
    const lines = parsePktLines(bodyBuf);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowArgs: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      const t = line.trim();
      const parts = t.split(' ');
      if (parts[0] === 'want' && parts[1]) wants.push(parts[1]);
      else if (parts[0] === 'have' && parts[1]) haves.push(parts[1]);
      else if (parts[0] === 'shallow' && parts[1]) shallowArgs.push(parts[1]);
      else if (parts[0] === 'deepen') { const n = Number(parts[1]); if (Number.isFinite(n)) depth = n; }
    }
    const haveSet = new Set(haves);
    const { objects, shallow, unshallow } = fetchObjects(repo, wants, haveSet, depth, shallowArgs);
    const pack = buildPack(objects);
    const pre: Buffer[] = [];
    for (const h of haves) if (repo.objects.has(h)) pre.push(pkt(`ACK ${h}\n`));
    if (pre.length === 0) pre.push(pkt('NAK\n'));
    for (const s of shallow) pre.push(pkt(`shallow ${s}\n`));
    for (const s of unshallow) pre.push(pkt(`unshallow ${s}\n`));
    sendRaw(res, 200, Buffer.concat([...pre, sidebandPack(pack)]), 'application/x-git-upload-pack-result');
    return true;
  }
  if (sub === 'git-receive-pack' && method === 'POST') {
    const { lines, rest } = splitPktSection(bodyBuf);
    interface Cmd { oldOid: string; newOid: string; ref: string; }
    const cmds: Cmd[] = [];
    for (const line of lines) {
      const clean = line.split('\0')[0].trim();
      const parts = clean.split(' ');
      if (parts.length >= 3) cmds.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    let newObjects = new Map<string, GitObj>();
    if (rest.length >= 12) {
      try { newObjects = parsePack(rest); } catch { newObjects = new Map(); }
    }
    for (const [oid, obj] of newObjects) repo.objects.set(oid, obj);
    const report: string[] = [];
    for (const c of cmds) {
      const cur = repo.refs.get(c.ref);
      let okRef = true; let reason = '';
      if (c.newOid === ZERO_OID) {
        // delete
        if (cur === undefined) { okRef = false; reason = 'ref does not exist'; }
        else if (c.oldOid !== ZERO_OID && c.oldOid !== cur) { okRef = false; reason = 'old value does not match'; }
        else repo.refs.delete(c.ref);
      } else {
        if (c.oldOid === ZERO_OID) {
          if (cur !== undefined) { okRef = false; reason = 'already exists'; }
        } else if (cur === undefined) { okRef = false; reason = 'ref does not exist'; }
        else if (c.oldOid !== cur) { okRef = false; reason = 'old value does not match'; }
        else if (!isAncestor(repo, c.oldOid, c.newOid)) { okRef = false; reason = 'non-fast-forward'; }
        if (okRef) repo.refs.set(c.ref, c.newOid);
      }
      report.push(okRef ? `ok ${c.ref}\n` : `ng ${c.ref} ${reason}\n`);
    }
    const payload = `unpack ok\n${report.join('')}`;
    sendRaw(res, 200, Buffer.concat([sidebandText(payload), FLUSH]), 'application/x-git-receive-pack-result');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- dispatcher
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const q = queryOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        const bodyBuf = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? await readBody(req) : Buffer.alloc(0);
        if (path === '/api/graphql' && method === 'POST') { await handleGraphQL(req, res, bodyBuf); return; }
        if (path === '/mcp') { await handleMcp(req, res, bodyBuf); return; }
        if (path.startsWith('/api/v3')) {
          const handled = await handleRest(req, res, path, q, bodyBuf);
          if (!handled) jsonErr(res, 404, 'Not Found');
          return;
        }
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          const handled = await handleGit(req, res, path, q, bodyBuf);
          if (!handled) jsonErr(res, 404, 'Not Found');
          return;
        }
        jsonErr(res, 404, 'Not Found');
      } catch (e) {
        if (!res.headersSent) jsonErr(res, 500, e instanceof Error ? e.message : 'Internal Server Error');
        else { try { res.end(); } catch { /* ignore */ } }
      }
    })();
  });
}
