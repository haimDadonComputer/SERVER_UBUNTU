import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAccess } from '../src/project-access.ts';

const project = { runtime: { health: 'http', listenAddress: '0.0.0.0', port: 3000 } };
const addresses = [{ address: '192.0.2.20' }];
const resolve = (p = project, publication, hosts = ['control.example.test']) =>
    projectAccess(p, addresses, publication, hosts, 'control.example.test');

test('project links prefer publication, then saved URL, then a real interface address', () => {
    const p = { ...project, launch_url: 'https://saved.example.test/' };
    assert.equal(resolve(p, { url: 'https://app.example.test/' }).url, 'https://app.example.test/');
    assert.equal(resolve(p).url, p.launch_url);
    assert.equal(resolve().url, 'http://192.0.2.20:3000/');
    assert.equal(resolve({ runtime: { ...project.runtime, listenAddress: '127.0.0.1' } }).url, '');
    assert.equal(resolve({}).url, '');
    assert.equal(resolve({ runtime: { ...project.runtime, health: 'process' } }).url, '');
});

test('all link candidates reject management names on every port, descendants, credentials and unsafe URLs', () => {
    for (const url of [
        'https://CONTROL.example.test.:8443/',
        'https://sub.control.example.test/',
        'http://other-control.test:3000/',
        'javascript:alert(1)',
        'https://user:password@app.test/',
        'http://localhost:3000/',
        'http://127.0.0.1:3000/',
        'invalid',
    ]) {
        const result = resolve({ launch_url: url }, { url }, [
            'control.example.test',
            'other-control.test',
        ]);
        assert.equal(result.url, '', url);
    }
    const result = projectAccess(
        project,
        [{ address: '192.0.2.10' }, ...addresses],
        undefined,
        ['192.0.2.10'],
        'control.test'
    );
    assert.equal(result.url, 'http://192.0.2.20:3000/');
    for (const address of ['evil.test', '999.1.1.1', '0.0.0.0', '127.0.0.1', '192.0.2.20/path']) {
        assert.equal(projectAccess(project, [{ address }], undefined, [], 'control.test').url, '');
    }
});
