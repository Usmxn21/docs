/**
 * Docs validation gate. Runs in CI on every push/PR (and locally before you push).
 * Fails the build if anything that would break the published Mintlify site — or mislead
 * an integrating client — slips in.
 *
 *   1. docs.json is valid JSON.
 *   2. The OpenAPI spec is valid (duplicate keys, malformed YAML, etc. — this is what
 *      broke the live build on 2026-06-17: a duplicated `accurate: true` key failed the
 *      whole Mintlify build with "Failed to fetch OpenAPI file").
 *   3. No broken internal links.
 *   4. Accuracy guards — regex pins against the specific client-breaking mistakes we have
 *      already had to fix, so they can never silently come back:
 *        a. webhook signature examples must hash the RAW body, never JSON.stringify(req.body).
 *        b. card.expiring_soon must use expiryMonth/expiryYear, never expMonth/expYear.
 *        c. no links to /api-reference/endpoint/* (auto-generated slugs differ → 404).
 *
 * Run locally:  node scripts/validate-docs.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
const fail = (msg) => { console.error(`❌ ${msg}`); failures++; };
const ok = (msg) => console.log(`✅ ${msg}`);

// All call sites pass STATIC string literals (no interpolation, no user input), so there
// is no command-injection surface. Kept as a shell string for the npx pipeline ergonomics.
function run(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function walkMdx(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkMdx(p, acc);
    else if (name.endsWith('.mdx')) acc.push(p);
  }
  return acc;
}

// 1. docs.json valid JSON
try {
  JSON.parse(readFileSync('docs.json', 'utf8'));
  ok('docs.json is valid JSON');
} catch (e) {
  fail(`docs.json is not valid JSON: ${e.message}`);
}

// 2. OpenAPI spec valid (the duplicate-key class of failure)
{
  const r = run('npx -y mint@latest openapi-check api-reference/openapi.yaml');
  if (/definition is valid/i.test(r.out)) ok('OpenAPI spec is valid');
  else fail(`OpenAPI spec failed validation:\n${r.out.split('\n').filter(l => /error|duplicat|invalid/i.test(l)).join('\n') || r.out}`);
}

// 3. Broken links
{
  const r = run('npx -y mint@latest broken-links');
  if (/no broken links/i.test(r.out)) ok('No broken internal links');
  else fail(`Broken links found:\n${r.out}`);
}

// 4. Accuracy guards
{
  const mdx = walkMdx('.');
  // Code-pattern guards inspect ONLY fenced code blocks (```...```) — what a client
  // copy-pastes — so explanatory prose that *names* a bad pattern to warn against it
  // (e.g. "don't use JSON.stringify(req.body)") doesn't trip the guard.
  const codeOf = (f) => (readFileSync(f, 'utf8').match(/```[\s\S]*?```/g) || []).join('\n');
  const hitsCode = (re) => mdx.filter((f) => re.test(codeOf(f)));
  const hitsAll = (re) => mdx.filter((f) => re.test(readFileSync(f, 'utf8')));

  const stringifyBody = hitsCode(/JSON\.stringify\(\s*req\.body\s*\)/);
  if (stringifyBody.length) fail(`Webhook verification CODE must hash the RAW body, not JSON.stringify(req.body). Found in: ${stringifyBody.join(', ')}`);
  else ok('Webhook examples hash the raw body');

  const expShort = hitsCode(/\bexpMonth\b|\bexpYear\b/);
  if (expShort.length) fail(`card.expiring_soon JSON uses expiryMonth/expiryYear, not expMonth/expYear. Found in: ${expShort.join(', ')}`);
  else ok('card.expiring_soon uses expiryMonth/expiryYear');

  // Links can appear anywhere, so this one scans the whole file.
  const badApiLinks = hitsAll(/\]\(\/api-reference\/endpoint\//);
  if (badApiLinks.length) fail(`Links to /api-reference/endpoint/* break (auto-generated slugs differ). Use /api-reference. Found in: ${badApiLinks.join(', ')}`);
  else ok('No broken /api-reference/endpoint links');
}

console.log('');
if (failures) { console.error(`Docs validation FAILED (${failures} issue${failures > 1 ? 's' : ''}).`); process.exit(1); }
console.log('Docs validation passed.');
