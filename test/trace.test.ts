import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTrace, TraceCleaner } from '../src/trace.js';

test('runner 17.10 markers without leading CSI keep immediately following text at every split', () => {
    for (const [raw, expected] of [
        ['section_start:1795001606:prepare_executor\r\x1b[0KPreparing the "docker" executor', 'Preparing the "docker" executor'],
        ['section_start:1795001606:prepare_executor[collapsed=true]\r\x1b[0KPreparing the "docker" executor', 'Preparing the "docker" executor'],
        ['section_end:1795001606:prepare_executor\r\x1b[0KExecutor prepared', 'Executor prepared'],
        ['Previous line\nsection_start:1795001606:prepare_executor\r\x1b[0KPreparing\nsection_end:1795001607:prepare_executor\r\x1b[0KDone', 'Previous line\nPreparing\nDone'],
    ]) {
        assert.equal(cleanTrace(raw), expected);
        for (let at = 0; at <= raw.length; at++) {
            const cleaner = new TraceCleaner();
            assert.equal(cleaner.push(raw.slice(0, at)) + cleaner.push(raw.slice(at)) + cleaner.end(), expected);
        }
        const cleaner = new TraceCleaner();
        assert.equal([...raw].map(ch => cleaner.push(ch)).join('') + cleaner.end(), expected);
    }
});

test('trace cleanup is chunk-independent, preserves prose and drops valid CSI/OSC controls', () => {
    const raw = '\x1b[0Ksection_start:123:script[collapsed=true]\r\x1b[0KHeading\n\x1b[1;31mERROR é\x1b[0m\n\x1b]0;title\x1b\\\x1b[0Ksection_end:125:script\r\x1b[0K';
    const expected = 'Heading\nERROR é\n';
    assert.equal(cleanTrace(raw), expected);
    for (let at = 0; at <= raw.length; at++) {
        const cleaner = new TraceCleaner();
        assert.equal(cleaner.push(raw.slice(0, at)) + cleaner.push(raw.slice(at)) + cleaner.end(), expected);
    }
    for (const text of ['ordinary runner prose\n', 'section_start is literal\n', 'section_end:no timestamp\r', 's', 'section_start:123:unterminated'])
        assert.equal(cleanTrace(text), text);
});

test('lookalike prose, carriage returns and malformed escapes survive every split', () => {
    const examples = [
        'user output section_start:123:real prose\rnext',
        'user output section_start:123:script\r\x1b[0Knext',
        'section_start:123:script\r',
        '\x1b[0Ksection_start:123:real prose\r\x1b[0Knext',
        '\x1b[0Ksection_end:123:script[collapsed=true]\r\x1b[0Knext',
        '\x1b[0Ksection_start:123:script[unknown=true]\r\x1b[0Knext',
        'stray \x1b here \x1b',
        'progress 10%\rprogress 50%\rprogress 100%\n',
        'é中文😀 section_start in output\rfin',
        '\x1b[0Ksection_start:123:script\rmissing erase',
        '\x1b[31', '\x1b]unterminated', '\x1bPprivate\x1b\\',
    ];
    for (const raw of examples) {
        const expected = raw.replaceAll('\x1b[0K', '');
        for (let at = 0; at <= raw.length; at++) {
            const cleaner = new TraceCleaner();
            assert.equal(cleaner.push(raw.slice(0, at)) + cleaner.push(raw.slice(at)) + cleaner.end(), expected);
        }
    }
    const long = '\x1b]' + 'x'.repeat(100000);
    assert.equal(cleanTrace(long), long);
});

test('complete sections and CSI/OSC forms are removed, incomplete framing stays', () => {
    for (const raw of [
        '\x1b[0Ksection_start:1:build.test-1\r\x1b[0K',
        '\x1b[0Ksection_end:2:build.test-1\r\x1b[0K',
        '\x9b31m\x9d0;title\x9c',
        '\x1b]0;title\x07',
    ]) {
        for (let at = 0; at <= raw.length; at++) {
            const cleaner = new TraceCleaner();
            assert.equal(cleaner.push(raw.slice(0, at)) + cleaner.push(raw.slice(at)) + cleaner.end(), '');
        }
    }
});
