import assert from 'node:assert/strict';
import type { GeneratedDeviceDefinition } from './device-compiler.ts';
import { generatedDeviceMethodsSource } from './device-codegen.ts';

const definition: GeneratedDeviceDefinition = {
  schemaVersion: 1,
  type: 'TEST_DEVICE',
  className: 'test_device',
  hierarchy: ['test_device'],
  sourceFiles: ['src/devices/test.cpp'],
  constants: { LIMIT: 4 },
  members: [
    { name: 'm_total', valueType: 'uint16_t', bits: 16, initial: 0 },
    { name: 'm_budget', valueType: 'int', bits: 32, signed: true, initial: 0 },
  ],
  callbacks: [],
  timers: [],
  methods: [
    {
      name: 'step',
      parameters: 'uint16_t value',
      source: { file: 'src/devices/test.cpp', line: 1 },
      program: {
        diagnostics: [],
        operations: [{
          op: 'return',
          value: {
            kind: 'binary',
            operator: '+',
            left: { kind: 'identifier', name: 'value' },
            right: { kind: 'number', value: 1 },
          },
        }],
      },
    },
    {
      name: 'render',
      parameters: '',
      source: { file: 'src/devices/test.cpp', line: 2 },
      program: {
        diagnostics: [],
        operations: [{
          op: 'for',
          initialize: [{
            op: 'declare',
            name: 'y',
            valueType: 'int',
            value: { kind: 'number', value: 0 },
          }],
          condition: {
            kind: 'binary',
            operator: '<',
            left: { kind: 'identifier', name: 'y' },
            right: { kind: 'identifier', name: 'LIMIT' },
          },
          iterate: {
            op: 'assign',
            target: { kind: 'identifier', name: 'y' },
            operator: '+=',
            value: { kind: 'number', value: 1 },
          },
          body: [{
            op: 'for',
            initialize: [{
              op: 'declare',
              name: 'x',
              valueType: 'int',
              value: { kind: 'number', value: 0 },
            }],
            condition: {
              kind: 'binary',
              operator: '<',
              left: { kind: 'identifier', name: 'x' },
              right: { kind: 'identifier', name: 'LIMIT' },
            },
            iterate: {
              op: 'assign',
              target: { kind: 'identifier', name: 'x' },
              operator: '+=',
              value: { kind: 'number', value: 1 },
            },
            body: [{
              op: 'assign',
              target: { kind: 'identifier', name: 'm_total' },
              operator: '+=',
              value: {
                kind: 'call',
                callee: { kind: 'identifier', name: 'step' },
                args: [{ kind: 'identifier', name: 'x' }],
              },
            }, {
              op: 'assign',
              target: { kind: 'identifier', name: 'm_budget' },
              operator: '-=',
              value: { kind: 'number', value: 1 },
            }],
          }],
        }],
      },
    },
    {
      name: 'cold_path',
      parameters: '',
      source: { file: 'src/devices/test.cpp', line: 3 },
      program: {
        diagnostics: [],
        operations: [{
          op: 'assign',
          target: { kind: 'identifier', name: 'm_total' },
          operator: '=',
          value: { kind: 'number', value: 0 },
        }],
      },
    },
  ],
  summary: { methods: 3, compiledMethods: 3, diagnostics: 0 },
};

const emitted = generatedDeviceMethodsSource(definition);
assert.deepEqual(emitted.methods.sort(), ['render', 'step']);
assert.doesNotMatch(emitted.source, /method_cold_path/);

const methods = Function(`return ${emitted.source}`)() as Record<
  string,
  (runtime: { members: Record<string, unknown> }) => unknown
>;
const runtime = { members: { m_total: 0, m_budget: 0 } };
methods.render!(runtime);
assert.equal(runtime.members.m_total, 40);
assert.equal(runtime.members.m_budget, -16);

console.log('device-codegen.spec: IR selection, dependency closure and execution passed');
