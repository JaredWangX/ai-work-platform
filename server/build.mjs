import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

const assets = {
  '/':['index.html','text/html; charset=utf-8'],
  '/composer-glass.mjs':['composer-glass.mjs','text/javascript; charset=utf-8'],
  '/auth-story.mjs':['auth-story.mjs','text/javascript; charset=utf-8'],
  '/workspace-motion.mjs':['workspace-motion.mjs','text/javascript; charset=utf-8'],
  '/vendor/gsap.min.js':['vendor/gsap.min.js','text/javascript; charset=utf-8'],
  '/workspace.css':['workspace.css','text/css; charset=utf-8'],
  '/api.mjs':['api.mjs','text/javascript; charset=utf-8'],
  '/app.js':['app.js','text/javascript; charset=utf-8'],
  '/showcase.js':['showcase.js','text/javascript; charset=utf-8'],
  '/team-sync.mjs':['team-sync.mjs','text/javascript; charset=utf-8'],
  '/workspace-client.mjs':['workspace-client.mjs','text/javascript; charset=utf-8'],
  '/office-files.mjs':['office-files.mjs','text/javascript; charset=utf-8'],
  '/events.mjs':['events.mjs','text/javascript; charset=utf-8'],
  '/commands.mjs':['commands.mjs','text/javascript; charset=utf-8'],
  '/markdown.mjs':['markdown.mjs','text/javascript; charset=utf-8'],
  '/vendor/markdown-it.mjs':['vendor/markdown-it.mjs','text/javascript; charset=utf-8'],
  '/vendor/markdown-it-license.txt':['vendor/markdown-it-license.txt','text/plain; charset=utf-8'],
  '/help.mjs':['help.mjs','text/javascript; charset=utf-8'],
  '/data.js':['data.js','text/javascript; charset=utf-8'],
  '/icons.js':['icons.js','text/javascript; charset=utf-8'],
  '/style.css':['style.css','text/css; charset=utf-8'],
  '/assets/wordmark-blue.png':['assets/wordmark-blue.png','image/png'],
  '/assets/brand-mark.png':['assets/brand-mark.png','image/png'],
  '/assets/logo.png':['assets/logo.png','image/png'],
  '/assets/favicon.png':['assets/favicon.png','image/png'],
  '/lucide-license.txt':['lucide-license.txt','text/plain; charset=utf-8'],
};
const deliverableTypes = {
  pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  webp:'image/webp',
  docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
for (const name of await readdir(new URL('../dist/assets/deliverables/',import.meta.url))) {
  const mime = deliverableTypes[name.split('.').at(-1)];
  if (mime) assets['/assets/deliverables/'+name] = ['assets/deliverables/'+name,mime];
}
for (const entry of Object.values(assets)) {
  entry.push((await readFile(new URL('../dist/'+entry[0],import.meta.url))).toString('base64'));
}
const modules = ['../dist/events.mjs','./autodl-bridge.mjs','./office.mjs','./workspace.mjs','./model.mjs'];
const backend = await Promise.all(modules.map(async source =>
  (await readFile(new URL(source,import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,''),
));
await mkdir(new URL('../dist/server/',import.meta.url),{recursive:true});
await writeFile(new URL('../dist/server/index.js',import.meta.url),backend.join('\n') + '\nconst assets = ' + JSON.stringify(assets) + `;\n
export default {
  fetch(request, env) {
    const {pathname} = new URL(request.url);
    if (pathname === '/api/workspace') return workspaceRoute(request,env);
    if (pathname.startsWith('/api/')) return modelRoute(request,env);
    const asset = assets[pathname === '/index.html' ? '/' : pathname];
    if (!asset) return new Response('未找到页面', {status:404});
    if (!['GET','HEAD'].includes(request.method)) return new Response(null, {status:405});
    const headers = {
      'Content-Type':asset[1],
      'Cache-Control':pathname.startsWith('/assets/') ? 'public, max-age=3600' : 'no-cache',
      'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'same-origin',
      'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    };
    const body = request.method === 'HEAD' ? null : Uint8Array.from(atob(asset[2]),char=>char.charCodeAt(0));
    return new Response(body,{headers});
  }
};
`);
