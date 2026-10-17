import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../viewer.html', import.meta.url), 'utf8');
const save = html.slice(html.indexOf('    function saveCurrentFeedback()'), html.indexOf('    // ---- Done ----'));
const done = html.slice(html.indexOf('    function showDoneDialog()'), html.indexOf('    function closeDoneDialog()'));
const grades = html.slice(html.indexOf('    function renderGrades('), html.indexOf('    function toggleGrades('));
const escape = html.slice(html.indexOf('    function escapeHtml('), html.indexOf('    // ---- View switching ----'));
const benchmark = html.slice(html.indexOf('    function renderBenchmark('), html.indexOf('    // ---- Start ----'));
const spreadsheet = html.slice(html.indexOf('    function renderXlsx('), html.indexOf('    // ---- Grades ----'));

test('spreadsheet previews append only sanitised fragments and preserve sheet labels', () => {
  const calls = [];
  const children = [];
  const context = vm.createContext({
    atob: () => '', Uint8Array,
    XLSX: { read: () => ({ SheetNames: ['<i>Literal sheet</i>', 'Second'], Sheets: {} }),
      utils: { sheet_to_html: () => '<table><td><a href="javascript:synthetic()">Link</a></td></table>' } },
    DOMPurify: { isSupported: true, sanitize: (dirty, options) => {
      calls.push({ dirty, options });
      return { nodeType: 11, sanitised: true };
    } },
    document: { createElement: () => ({ style: {}, textContent: '', appendChild(node) {
      assert.equal(node.nodeType, 11);
      assert.equal(node.sanitised, true);
    }, set innerHTML(value) { throw new Error('unsanitised HTML insertion'); } }) },
  });
  vm.runInContext(spreadsheet, context);
  context.renderXlsx({ appendChild: node => children.push(node) }, '');
  assert.equal(calls.length, 2);
  assert.equal(children.length, 4);
  assert.equal(children[0].textContent, 'Sheet: <i>Literal sheet</i>');
  assert.equal(children[2].textContent, 'Sheet: Second');
  for (const { options } of calls) {
    assert.equal(options.RETURN_DOM_FRAGMENT, true);
    assert.notEqual(options.ALLOW_UNKNOWN_PROTOCOLS, true);
  }
});

test('spreadsheet previews fail closed when sanitising is unavailable', () => {
  for (const purifier of [undefined, { isSupported: false }]) {
    const read = () => { throw new Error('must not parse without a sanitiser'); };
    const context = vm.createContext({ atob: () => '', Uint8Array, XLSX: { read }, DOMPurify: purifier });
    vm.runInContext(spreadsheet, context);
    const container = { textContent: '', appendChild() { assert.fail('must not append unsafe content'); } };
    context.renderXlsx(container, '');
    assert.equal(container.textContent, 'Error rendering spreadsheet: Spreadsheet preview is unavailable.');
  }
});

function renderer(data = {}) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, classList: { remove() {} }, innerHTML: '' });
      return elements.get(id);
    },
    createElement() {
      return {
        textContent: '',
        get innerHTML() {
          return String(this.textContent ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        },
      };
    },
  };
  const context = vm.createContext({ EMBEDDED_DATA: { benchmark: data }, document });
  vm.runInContext(escape + grades + benchmark, context);
  return { context, elements };
}

test('grading counts remain text instead of markup', () => {
  for (const field of ['passed', 'failed', 'total']) {
    const { context, elements } = renderer();
    context.renderGrades({ grading: { summary: { [field]: '<i data-injection="yes">synthetic</i>' } } });
    const output = elements.get('grades-content').innerHTML;
    assert.ok(!output.includes('<i data-injection'));
    assert.ok(output.includes('&lt;i data-injection='));
  }
});

test('every raw benchmark value stays in its text or quoted-attribute boundary', () => {
  const payload = '<i data-injection="yes">synthetic</i>';
  const setters = [
    data => { data.metadata = { timestamp: payload }; },
    data => { data.metadata = { evals_run: [payload] }; },
    data => { data.metadata = { runs_per_configuration: payload }; },
    ...['pass_rate', 'time_seconds', 'tokens'].map(field => data => { data.run_summary.delta[field] = payload; }),
    ...['configuration', 'run_number'].map(field => data => { data.runs[0][field] = payload; }),
    ...['passed', 'total', 'errors'].map(field => data => { data.runs[0].result[field] = payload; }),
  ];
  for (const set of setters) {
    const data = {
      run_summary: { with_skill: { time_seconds: { mean: 1, stddev: 0 }, tokens: { mean: 2, stddev: 0 } }, without_skill: {}, delta: {} },
      runs: [{ eval_id: 1, configuration: 'with_skill', run_number: 1,
        result: { pass_rate: 1, passed: 1, total: 1, errors: 1 },
        expectations: [{ text: 'Synthetic assertion', passed: true, evidence: 'Synthetic evidence' }] },
      { eval_id: 1, configuration: 'without_skill', run_number: 2,
        result: { pass_rate: 0, passed: 0, total: 1, errors: 1 } }],
    };
    set(data);
    const { context, elements } = renderer(data);
    context.renderBenchmark();
    const output = elements.get('benchmark-content').innerHTML;
    assert.ok(!/<i\s+data-injection/i.test(output));
    assert.match(output, /&lt;i\s+data-injection/i);
  }
  for (const field of ['run_number', 'evidence']) {
    const run = { eval_id: 1, configuration: 'with_skill', run_number: 1, result: { pass_rate: 1 },
      expectations: [{ text: 'Assertion', passed: true, evidence: 'Evidence' }] };
    if (field === 'run_number') run.run_number = '" data-injection="yes';
    else run.expectations[0].evidence = '" data-injection="yes';
    const { context, elements } = renderer({ runs: [run] });
    context.renderBenchmark();
    const output = elements.get('benchmark-content').innerHTML;
    assert.ok(!output.includes('" data-injection="yes'));
    assert.ok(output.includes('&quot; data-injection=&quot;yes'));
  }
});

test('ordinary values, named evals, signed deltas and zero fallbacks keep their meaning', () => {
  const { context, elements } = renderer({
    metadata: { evals_run: ['named-eval'], runs_per_configuration: 3 },
    run_summary: { with_skill: { pass_rate: { mean: 0.8, stddev: 0 } }, without_skill: {}, delta: { pass_rate: '+5.0%' } },
  });
  context.renderBenchmark();
  const output = elements.get('benchmark-content').innerHTML;
  assert.ok(output.includes('Evals: named-eval'));
  assert.ok(output.includes('3 runs per configuration'));
  assert.ok(output.includes('80% ± 0%'));
  assert.ok(output.includes('+5.0%'));
  context.renderGrades({ grading: { summary: { passed: 0, failed: 0, total: 0 } } });
  assert.ok(elements.get('grades-content').innerHTML.includes('0 passed, 0 failed of 0'));
  assert.equal(context.escapeHtml('&lt; &#34; & " \' Unicode'), '&amp;lt; &amp;#34; &amp; &quot; &#39; Unicode');
});

for (const outcome of [200, 404, 500, 'offline']) {
  for (const action of ['saveCurrentFeedback', 'showDoneDialog']) {
    test(`${action} handles ${outcome}`, async () => {
      const events = [];
      let downloaded;
      const elements = {
        feedback: { value: 'Synthetic feedback' },
        'feedback-status': { textContent: '' },
        'done-overlay': { classList: { add: () => events.push('overlay') } },
      };
      const context = vm.createContext({
        EMBEDDED_DATA: { runs: [{ id: 'synthetic-run' }] },
        currentIndex: 0,
        feedbackMap: {},
        document: {
          getElementById: id => elements[id],
          createElement: () => ({ click: () => events.push('download') }),
        },
        fetch: async () => {
          if (outcome === 'offline') throw new Error('Synthetic network failure');
          return { ok: outcome === 200, status: outcome };
        },
        Blob: class { constructor(parts) { downloaded = parts.join(''); } },
        URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL: () => {} },
      });
      vm.runInContext(save + done, context);
      context[action]();
      await new Promise(resolve => setImmediate(resolve));
      if (action === 'saveCurrentFeedback') {
        assert.equal(elements['feedback-status'].textContent,
          outcome === 200 ? 'Saved' : 'Will download on submit');
      } else if (outcome === 200) {
        assert.deepEqual(events, ['overlay']);
        assert.equal(downloaded, undefined);
      } else {
        assert.deepEqual(events, ['download', 'overlay']);
        assert.equal(JSON.parse(downloaded).status, 'complete');
        assert.equal(JSON.parse(downloaded).reviews[0].feedback, 'Synthetic feedback');
      }
    });
  }
}
