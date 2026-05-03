import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const failures = [];

const forbiddenSecrets = [
  'mira755colo',
];

for (const secret of forbiddenSecrets) {
  if (source.includes(secret)) {
    failures.push(`Forbidden historical secret still present in index.js: ${secret}`);
  }
}

if (/const\s+UPDATE_SECRET\s*=\s*['\"][^'\"]+['\"]/.test(source)) {
  failures.push('Hardcoded const UPDATE_SECRET detected. Use env.UPDATE_SECRET via getUpdateSecret(env).');
}

if (!source.includes('function getUpdateSecret(env)')) {
  failures.push('Missing getUpdateSecret(env) helper.');
}

const tokenChecks = [...source.matchAll(/searchParams\.get\(['\"]token['\"]\)/g)].length;
const helperUses = [...source.matchAll(/getUpdateSecret\(env\)/g)].length;

if (tokenChecks > 0 && helperUses < tokenChecks + 1) {
  failures.push(`Potential unsafe token checks: token checks=${tokenChecks}, getUpdateSecret(env) uses=${helperUses}.`);
}

if (source.includes('url.searchParams.get("token") !== UPDATE_SECRET') || source.includes("url.searchParams.get('token') !== UPDATE_SECRET")) {
  failures.push('Old token comparison against UPDATE_SECRET symbol detected.');
}

if (failures.length) {
  console.error('\nSecurity check failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Security check passed: no hardcoded update secret regression detected.');
