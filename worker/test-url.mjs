/**
 * Tests the check-in link builder from the shipped admin.js.
 *
 * GitHub Pages serves the admin page at BOTH /admin.html and the extensionless
 * /admin, and the local dev server uses /admin.html, so the link has to come
 * out right for every form the browser might show.
 */
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../docs/assets/admin.js', import.meta.url), 'utf8');

function extract(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('cannot find ' + name);
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const checkinUrlSrc = extract('checkinUrl');
let pass = 0, fail = 0;
function check(label, got, want) {
  if (got === want) { pass++; console.log('  PASS  ' + label + '  ' + got); }
  else { fail++; console.log('  FAIL  ' + label + '\n          got:  ' + got + '\n          want: ' + want); }
}

function urlFor(origin, pathname, id) {
  const location = { origin, pathname };
  // eslint-disable-next-line no-new-func
  const fn = new Function('location', checkinUrlSrc + '; return checkinUrl;')(location);
  return fn(id);
}

const E = '29jrcj';
const GH = 'https://ipswichkartclub.github.io';

console.log('\n=== GitHub Pages, site at the domain root ===');
check('/admin.html', urlFor(GH, '/admin.html', E), GH + '/?e=' + E);
check('/admin (extensionless)', urlFor(GH, '/admin', E), GH + '/?e=' + E);
check('/admin/ (trailing slash)', urlFor(GH, '/admin/', E), GH + '/?e=' + E);
check('/ADMIN.HTML (case)', urlFor(GH, '/ADMIN.HTML', E), GH + '/?e=' + E);
check('/admin.htm', urlFor(GH, '/admin.htm', E), GH + '/?e=' + E);

console.log('\n=== project site served from a subpath ===');
const SUB = 'https://hbwoody.github.io';
check('/repo/admin.html', urlFor(SUB, '/driver-briefing-checkin/admin.html', E),
  SUB + '/driver-briefing-checkin/?e=' + E);
check('/repo/admin', urlFor(SUB, '/driver-briefing-checkin/admin', E),
  SUB + '/driver-briefing-checkin/?e=' + E);

console.log('\n=== local dev server ===');
const L = 'http://localhost:8787';
check('/admin.html', urlFor(L, '/admin.html', E), L + '/?e=' + E);
check('/admin', urlFor(L, '/admin', E), L + '/?e=' + E);

console.log('\n=== odd but survivable ===');
check('root itself', urlFor(GH, '/', E), GH + '/?e=' + E);
check('empty path', urlFor(GH, '', E), GH + '/?e=' + E);
check('some other file', urlFor(GH, '/tools/console.html', E), GH + '/tools/?e=' + E);
check('a folder named admin is NOT stripped mid-path',
  urlFor(GH, '/admin/tools/admin.html', E), GH + '/admin/tools/?e=' + E);
check('event id is url-encoded', urlFor(GH, '/admin.html', 'a b&c'), GH + '/?e=a%20b%26c');

console.log('\n=== the resulting links must be the ones that actually serve ===');
check('no index.html in the link', urlFor(GH, '/admin', E).indexOf('index.html'), -1);
check('no double slash', urlFor(GH, '/admin', E).indexOf('//?'), -1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
