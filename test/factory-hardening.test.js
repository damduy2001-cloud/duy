'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
function extractBlock(start, end) { const a = html.indexOf(start); const b = html.indexOf(end, a); assert.ok(a >= 0 && b > a, `missing source block ${start}`); return html.slice(a, b); }

test('R1.5 uses isolated IndexedDB namespace and explicit backup handoff', () => {
  assert.match(html, /DB_NAME='ydtt_factory_v271'/);
  assert.match(html, /ydtt_factory_v271/);
  assert.match(html, /không tự đọc\/ghi kho R1\.1–R1\.4/);
  assert.match(html, /importBackup\s*=\s*function/);
});
test('effective save path serializes writes and retains cross-tab revision guard', () => {
  assert.match(html, /let ydttV271SaveQueue=Promise\.resolve\(\)/);
  assert.match(html, /ydttV271SaveQueue\.then\(\(\)=>ydttV271BaseSave\(\)\)/);
  assert.match(html, /actualRevision!==expectedRevision/);
  assert.match(html, /Phát hiện một tab khác đã lưu phiên bản mới hơn/);
});
test('canonical outline and Global Static Prefix remain byte-identical to R1.4', () => {
  const old = fs.readFileSync('/mnt/data/ydtt-final-audit/YDTT-Factory-v2.7.0-R1.4-APIVN-RELAY.html', 'utf8');
  const get = (source, re) => { const m = source.match(re); assert.ok(m); return m[1]; };
  const canonRe = /<script id="embedded-outline" type="application\/json">([\s\S]*?)<\/script>/;
  const prefixRe = /const YDTT_GLOBAL_STATIC_PREFIX\s*=\s*(\[[\s\S]*?\]);/;
  assert.equal(get(html, canonRe), get(old, canonRe));
  assert.equal(get(html, prefixRe), get(old, prefixRe));
});
test('substantive CPS, Argument Map, Blueprint and Rolling State validators reject empty or inconsistent records', () => {
  const code = extractBlock('function ydttV271HasSubstance', '\nconst ydttV271OriginalPreflight=');
  const ctx = { ydttV271ApprovalValid: () => true }; vm.createContext(ctx); vm.runInContext(code, ctx);
  const base = {
    code: 'CH-1', outlineNodes: [{ id: 'n1' }, { id: 'n2' }],
    cps: { central_question: 'Q', contribution: 'C', chapter_style_strategy: 'S', scope: { in_scope: ['in'], out_of_scope: ['out'], boundaries: ['bounds'] }, sections: ['n1', 'n2'].map(node_id => ({ node_id, purpose: 'p', depth: 'd', knowledge_types: ['k'], method_plan: ['m'], deliverables: ['d'], evidence_requirements: ['e'], counterquestions: ['q'], acceptance_tests: ['a'] })) },
    sources: [{ id: 's1' }],
    argumentMap: { claims: ['n1', 'n2'].map((node_id, i) => ({ claim_id: 'c' + i, node_id, claim: 'claim', claim_type: 'HISTORICAL', epistemic_status: 'ATTESTED', reasoning_step: 'step', premises: ['premise'], counterarguments: ['counter'], boundary_conditions: ['boundary'], evidence_source_ids: ['s1'] })), argument_spine: ['spine'], unsupported_claims_to_avoid: [] },
    blueprint: { chapter_code: 'CH-1', thesis_scope: 'scope', owned_concepts: [{ concept: 'concept', node_ids: ['n1'] }], allowed_mentions: ['allowed'], excluded_or_deferred: ['excluded'], overlap_risks: ['risk'], xt_obligations: ['xt'], source_gates: ['gate'], acceptance_tests: ['test'], assumptions: ['assumption'] },
    sidecar: { owner_scope: ['owner'], forbidden_overlap: ['avoid'], rollingState: { completed_sections: ['n1'] } }
  };
  assert.equal(ctx.ydttV271CheckCPS(base), '');
  assert.equal(ctx.ydttV271CheckArgumentMap(base), '');
  assert.equal(ctx.ydttV271CheckBlueprint(base), '');
  assert.match(ctx.ydttV271CheckCPS({ ...base, cps: { ...base.cps, scope: { ...base.cps.scope, out_of_scope: [] } } }), /nội dung thực chất/);
  assert.match(ctx.ydttV271CheckArgumentMap({ ...base, argumentMap: { ...base.argumentMap, claims: base.argumentMap.claims.slice(0, 1) } }), /chưa có claim/);
  assert.match(ctx.ydttV271CheckArgumentMap({ ...base, argumentMap: { ...base.argumentMap, claims: [{ ...base.argumentMap.claims[0], evidence_source_ids: ['missing'], source_gap: '' }, base.argumentMap.claims[1]] } }), /source_id không tồn tại/);
  assert.match(ctx.ydttV271CheckBlueprint({ ...base, blueprint: { ...base.blueprint, source_gates: [] } }), /source_gates/);
  assert.match(ctx.ydttV271CheckRolling({ ...base, sections: [{ node_id: 'n1', text: 'draft' }], sidecar: { rollingState: { completed_sections: ['n1', 'n1'] } } }), /trùng/);
});
test('Relay endpoint uses the correct /v1 routes and rejects path-bearing Relay URL', () => {
  const code = extractBlock('function endpoint(){', '\nasync function apiCall');
  const ctx = { settings: { connectionMode: 'relay', relayUrl: 'https://relay.example' }, URL, Error }; vm.createContext(ctx); vm.runInContext(code, ctx);
  assert.equal(ctx.endpoint(), 'https://relay.example/v1/chat/completions');
  assert.equal(ctx.modelsEndpoint(), 'https://relay.example/v1/models');
  ctx.settings.relayUrl = 'https://relay.example/v1';
  assert.throws(() => ctx.endpoint());
});

test('R1.5.1 blocks APIVN Direct before browser fetch and explains Relay requirement', () => {
  assert.match(html, /ydttIsApivnDirect/);
  assert.match(html, /ydttAssertSupportedTransport\(\)/);
  assert.match(html, /APIVN yêu cầu gọi từ phía máy chủ/);
  assert.match(html, /KHÔNG HỖ TRỢ APIVN DIRECT/);
  assert.match(html, /runPipeline=async function/);
  assert.match(html, /apiCall=async function/);
});
test('APIVN direct detector is host-aware and leaves Relay/other providers unaffected', () => {
  const a = html.indexOf('function ydttIsApivnDirect()');
  const b = html.indexOf('\nfunction ydttApivnRelayRequiredMessage()', a);
  assert.ok(a >= 0 && b > a);
  const code = html.slice(a, b);
  const ctx = { settings: { connectionMode: 'direct', baseUrl: 'https://apivn.vn/v1' }, URL };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  assert.equal(ctx.ydttIsApivnDirect(), true);
  ctx.settings.baseUrl = 'https://sub.apivn.vn/v1';
  assert.equal(ctx.ydttIsApivnDirect(), true);
  ctx.settings.baseUrl = 'https://api.example.com/v1';
  assert.equal(ctx.ydttIsApivnDirect(), false);
  ctx.settings.connectionMode = 'relay'; ctx.settings.baseUrl = 'https://apivn.vn/v1';
  assert.equal(ctx.ydttIsApivnDirect(), false);
});
test('APIVN documented model ID replaces truncated initial model ID', () => {
  assert.match(html, /model:'deepseek-v4\.1-flash'/);
  assert.match(html, /settings\.model==='deepseek-v4\.1-fl'\)settings\.model='deepseek-v4\.1-flash'/);
});
