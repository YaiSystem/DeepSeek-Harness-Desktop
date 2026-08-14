function parseVersion(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  const ha = pa.pre.length > 0, hb = pb.pre.length > 0;
  if (!ha && !hb) return 0;
  if (!ha) return 1;
  if (!hb) return -1;
  const max = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < max; i++) {
    const ta = pa.pre[i], tb = pb.pre[i];
    if (ta === undefined) return -1;
    if (tb === undefined) return 1;
    if (ta === tb) continue;
    const na = /^\d+$/.test(ta) ? Number(ta) : null;
    const nb = /^\d+$/.test(tb) ? Number(tb) : null;
    if (na !== null && nb !== null) return na > nb ? 1 : -1;
    return ta > tb ? 1 : -1;
  }
  return 0;
}
const cases = [
  ['0.1.0-rc.99', '0.1.0-rc.6', 1],
  ['0.1.0', '0.1.0-rc.6', 1],
  ['0.1.0', '0.1.0', 0],
  ['0.2.0-rc.1', '0.1.0-rc.6', 1],
  ['0.1.1', '0.1.0', 1],
  ['0.1.0-rc.6', '0.1.0-rc.99', -1],
];
let fail = 0;
for (const [a, b, exp] of cases) {
  const got = compareVersions(a, b);
  const ok = got === exp;
  if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + a + ' vs ' + b + ' -> ' + got + ' (期望 ' + exp + ')');
}
console.log(fail === 0 ? '全部通过' : '有 ' + fail + ' 个失败');
